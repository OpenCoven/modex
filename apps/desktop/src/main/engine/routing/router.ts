import path from "node:path";
import type { BackendId, ModelInfo, RoutingPolicy, RoutingStatus, Thread, ThreadItem } from "../../../shared/types.js";
import { ladder, tierOf, type Candidate } from "./catalog.js";
import { Fit } from "./fit.js";
import { DEFAULT_JEV_MODEL, httpTransport, JevError, resolveTypesafeKey, type JevTransport, type KeySource } from "./jev.js";
import { judgeHeuristically, judgeWithJev, stateFor, QUESTION_SET_VERSION, type JudgeSource, type Judgments } from "./judge.js";
import { decide, type Decision } from "./policy.js";

export interface RouterOptions {
  home: string;
  policy: () => RoutingPolicy;
  listModels: (backend: BackendId) => Promise<{ models: ModelInfo[]; error?: string }>;
  /**
   * undefined → resolve TYPESAFE_API_KEY lazily and use the HTTP transport;
   * null → never call Jev (offline / tests); a function → injected transport.
   */
  transport?: JevTransport | null;
  env?: NodeJS.ProcessEnv;
  /** Judge timeout; the heuristic takes over past it. */
  timeoutMs?: number;
}

export interface RouteInput {
  thread: Thread;
  text: string;
  items: ThreadItem[];
  project: { name: string; branch?: string | null; changedFiles?: number };
}

export interface RouteReceipt {
  item: Extract<ThreadItem, { kind: "route" }>;
  judgments: Judgments;
  decision: Decision;
  source: JudgeSource;
  questionSetVersion: number;
}

/** Ties the judge, catalogue, policy, and fit together for the ThreadRunner. */
export class Router {
  readonly fit: Fit;
  private transportPromise: Promise<{ transport: JevTransport | null; keySource: KeySource }> | null = null;
  private readonly ladders = new Map<BackendId, { at: number; rungs: Candidate[]; error?: string }>();
  /** Set after an auth or billing rejection: retrying every turn would only add latency. */
  private jevDisabled: string | null = null;

  constructor(private readonly o: RouterOptions) {
    this.fit = new Fit(path.join(o.home, "app", "routing-fit.json"));
  }

  private transport(): Promise<{ transport: JevTransport | null; keySource: KeySource }> {
    if (this.o.transport === null) return Promise.resolve({ transport: null, keySource: "none" });
    if (this.o.transport) return Promise.resolve({ transport: this.o.transport, keySource: "env" });
    return (this.transportPromise ??= resolveTypesafeKey(this.o.env ?? process.env).then(({ key, source }) => ({ transport: key ? httpTransport(key, { timeoutMs: this.o.timeoutMs ?? 8000 }) : null, keySource: source })));
  }

  /** Model ladders are cached for a minute; the CLIs' lists rarely change mid-session. */
  private async ladderFor(backend: BackendId): Promise<Candidate[]> {
    const hit = this.ladders.get(backend);
    if (hit && Date.now() - hit.at < 60_000) return hit.rungs;
    const r = await this.o.listModels(backend);
    const rungs = ladder(backend, r.models);
    this.ladders.set(backend, { at: Date.now(), rungs, error: r.error });
    return rungs;
  }

  /** Tier of a model the user picked by hand, for the override signal. */
  async tierOfModel(backend: BackendId, model: string): Promise<number | undefined> {
    const rungs = await this.ladderFor(backend);
    const c = rungs.find((x) => x.model === model);
    return c ? c.tier : model ? tierOf({ id: model, label: model }) : undefined;
  }

  async status(): Promise<RoutingStatus> {
    const { transport, keySource } = await this.transport();
    const detail = this.jevDisabled ?? (transport ? undefined : "No TYPESAFE_API_KEY found in the environment or your login shell.");
    const fit = this.fit.snapshot();
    const tasks: RoutingStatus["fit"]["tasks"] = {};
    for (const [k, v] of Object.entries(fit.tasks)) if (v) tasks[k] = { offset: Math.round(v.offset * 100) / 100, samples: v.samples, overridesUp: v.overridesUp, overridesDown: v.overridesDown, failures: v.failures };
    return { live: Boolean(transport) && !this.jevDisabled, keySource, detail, model: this.o.policy().jev_model || DEFAULT_JEV_MODEL, questionSetVersion: QUESTION_SET_VERSION, fit: { tasks, premiumToday: this.fit.premiumToday(), routes: fit.history.length } };
  }

  async route(input: RouteInput, signal?: AbortSignal): Promise<RouteReceipt> {
    const started = Date.now();
    const policy = this.o.policy();
    const { thread } = input;
    const state = stateFor({ text: input.text, backend: thread.backend, model: thread.model, mode: thread.mode, plan: thread.plan, items: input.items, project: input.project });

    let judgments: Judgments;
    let source: JudgeSource = "heuristic";
    let fallback: string | undefined;
    const { transport } = await this.transport();
    if (this.jevDisabled) {
      fallback = `${this.jevDisabled} Used the built-in heuristic.`;
      judgments = judgeHeuristically(state);
    } else if (transport) {
      try {
        judgments = await judgeWithJev(state, transport, policy.jev_model || DEFAULT_JEV_MODEL, signal);
        source = "jev";
      } catch (err) {
        const why = err instanceof JevError ? `${err.message} (${err.code})` : (err as Error).message;
        if (err instanceof JevError && (err.code === "auth" || err.code === "billing")) this.jevDisabled = `Jev is off for this session — ${err.message} Fix the key or credits and restart Modex.`;
        fallback = `Jev unavailable — ${why}; used the built-in heuristic.`;
        judgments = judgeHeuristically(state);
      }
    } else {
      fallback = "No TypeSafe API key found; used the built-in heuristic.";
      judgments = judgeHeuristically(state);
    }

    const backends = new Set<BackendId>([thread.backend, ...(policy.allow_backend_switch ? policy.allow_backends : [])]);
    const ladders: Partial<Record<BackendId, Candidate[]>> = {};
    await Promise.all([...backends].map(async (b) => { ladders[b] = await this.ladderFor(b); }));

    const premiumExhausted = policy.premium_turns_per_day != null && this.fit.premiumToday() >= policy.premium_turns_per_day;
    const decision = decide({
      judgments, source, policy, ladders, premiumExhausted,
      current: { backend: thread.backend, model: thread.model, effort: thread.effort, hasSession: Boolean(thread.sessionHandle) },
      fitOffset: this.fit.offsetFor(judgments.task),
    });
    const premium = decision.tier === 3 || decision.effort === "xhigh" || decision.effort === "max";
    this.fit.recordRoute({ threadId: thread.id, task: judgments.task, source, backend: decision.backend, model: decision.model, effort: decision.effort, fast: decision.fast, tier: decision.tier, confidence: judgments.taskConfidence, premium: premium && !decision.pinned });

    const item: RouteReceipt["item"] = {
      id: `route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "route",
      backend: decision.backend,
      model: decision.model,
      effort: decision.effort,
      fast: decision.fast,
      source,
      task: judgments.task,
      confidence: Math.round(judgments.taskConfidence * 100) / 100,
      complexity: Math.round(judgments.complexity * 10) / 10,
      pinned: decision.pinned,
      reasons: fallback ? [fallback, ...decision.reasons] : decision.reasons,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    };
    return { item, judgments, decision, source, questionSetVersion: QUESTION_SET_VERSION };
  }

  noteOutcome(threadId: string, outcome: "completed" | "failed" | "interrupted"): void {
    this.fit.recordOutcome(threadId, outcome);
  }

  /** The user picked a model by hand on an Auto thread. Returns what the fit learned, for a notice. */
  async noteOverride(thread: Thread, model: string): Promise<{ task: string; from: number; to: number } | undefined> {
    const to = await this.tierOfModel(thread.backend, model);
    if (to === undefined) return undefined;
    const r = this.fit.recordOverride(thread.id, to);
    return r ? { task: r.task, from: r.tier, to } : undefined;
  }
}
