import fs from "node:fs";
import path from "node:path";
import type { TaskKind } from "./judge.js";

/**
 * The learning loop, kept deliberately legible: a per-task tier offset that moves when the
 * user overrides an Auto pick (strong signal) or an Auto turn fails (weak signal), plus a
 * daily counter for premium turns. Everything is a plain JSON file the user can read or delete.
 */
export interface FitTask {
  /** −1.5 … +1.5 tiers added to the policy's target for this task kind. */
  offset: number;
  samples: number;
  overridesUp: number;
  overridesDown: number;
  failures: number;
  completions: number;
}

export interface RouteRecord {
  at: string;
  threadId: string;
  task: TaskKind;
  source: "jev" | "heuristic";
  backend: string;
  model: string;
  effort?: string;
  fast: boolean;
  tier: number;
  confidence: number;
  premium: boolean;
  outcome?: "completed" | "failed" | "interrupted" | "overridden";
  overrideTier?: number;
}

export interface FitState {
  version: 1;
  tasks: Partial<Record<TaskKind, FitTask>>;
  premium: { day: string; count: number };
  history: RouteRecord[];
}

export const OVERRIDE_STEP = 0.34; // three consistent overrides move a task by one full tier
export const FAILURE_STEP = 0.1;
export const MAX_OFFSET = 1.5;
const HISTORY_LIMIT = 200;

const empty = (): FitTask => ({ offset: 0, samples: 0, overridesUp: 0, overridesDown: 0, failures: 0, completions: 0 });

export class Fit {
  private state: FitState;

  constructor(readonly file: string, private readonly today: () => string = () => new Date().toISOString().slice(0, 10)) {
    this.state = this.read();
  }

  private read(): FitState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<FitState>;
      return { version: 1, tasks: raw.tasks ?? {}, premium: raw.premium ?? { day: this.today(), count: 0 }, history: raw.history ?? [] };
    } catch {
      return { version: 1, tasks: {}, premium: { day: this.today(), count: 0 }, history: [] };
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  snapshot(): FitState {
    return structuredClone(this.state);
  }

  /** Rounded to the nearest 0.5 tier so a single override does not flip the decision. */
  offsetFor(task: TaskKind): number {
    const o = this.state.tasks[task]?.offset ?? 0;
    return Math.round(o * 2) / 2;
  }

  premiumToday(): number {
    const day = this.today();
    if (this.state.premium.day !== day) this.state.premium = { day, count: 0 };
    return this.state.premium.count;
  }

  recordRoute(record: Omit<RouteRecord, "at">): void {
    const t = (this.state.tasks[record.task] ??= empty());
    t.samples += 1;
    if (record.premium) {
      this.premiumToday();
      this.state.premium.count += 1;
    }
    this.state.history.push({ at: new Date().toISOString(), ...record });
    if (this.state.history.length > HISTORY_LIMIT) this.state.history.splice(0, this.state.history.length - HISTORY_LIMIT);
    this.write();
  }

  /** Latest route on a thread that has not been given an outcome yet. */
  private open(threadId: string): RouteRecord | undefined {
    for (let i = this.state.history.length - 1; i >= 0; i--) {
      const r = this.state.history[i]!;
      if (r.threadId === threadId) return r.outcome ? undefined : r;
    }
    return undefined;
  }

  recordOutcome(threadId: string, outcome: "completed" | "failed" | "interrupted"): void {
    const r = this.open(threadId);
    if (!r) return;
    r.outcome = outcome;
    const t = (this.state.tasks[r.task] ??= empty());
    if (outcome === "failed") {
      t.failures += 1;
      t.offset = Math.min(MAX_OFFSET, t.offset + FAILURE_STEP);
    } else if (outcome === "completed") t.completions += 1;
    this.write();
  }

  /**
   * The user changed model/effort after an Auto pick on this thread: the strongest signal we
   * have. Picking a higher tier than Auto did moves the task up; a lower one moves it down.
   */
  recordOverride(threadId: string, overrideTier: number): RouteRecord | undefined {
    const r = this.latest(threadId);
    if (!r || r.outcome === "overridden") return undefined;
    const delta = overrideTier - r.tier;
    if (delta === 0) return undefined;
    r.outcome = "overridden";
    r.overrideTier = overrideTier;
    const t = (this.state.tasks[r.task] ??= empty());
    if (delta > 0) t.overridesUp += 1;
    else t.overridesDown += 1;
    t.offset = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, t.offset + Math.sign(delta) * OVERRIDE_STEP * Math.min(2, Math.abs(delta))));
    this.write();
    return r;
  }

  latest(threadId: string): RouteRecord | undefined {
    for (let i = this.state.history.length - 1; i >= 0; i--) if (this.state.history[i]!.threadId === threadId) return this.state.history[i];
    return undefined;
  }

  reset(): void {
    this.state = { version: 1, tasks: {}, premium: { day: this.today(), count: 0 }, history: [] };
    this.write();
  }
}
