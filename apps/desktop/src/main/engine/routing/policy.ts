import type { BackendId, EffortLevel, RoutingPolicy } from "../../../shared/types.js";
import type { Candidate, Tier } from "./catalog.js";
import { pick } from "./catalog.js";
import type { JudgeSource, Judgments } from "./judge.js";

/**
 * Deterministic policy: judgments in, one concrete route out. No I/O, no model call.
 * Every step that changes the outcome appends a human-readable reason so the UI can answer
 * "why this model?" and the user can see what to tune.
 */
export const EFFORTS: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface DecisionInput {
  judgments: Judgments;
  source: JudgeSource;
  policy: RoutingPolicy;
  current: { backend: BackendId; model: string; effort?: string; hasSession: boolean };
  ladders: Partial<Record<BackendId, Candidate[]>>;
  /** Learned per-task tier offset (see fit.ts). */
  fitOffset: number;
  premiumExhausted: boolean;
}

export interface Decision {
  backend: BackendId;
  model: string;
  effort?: string;
  fast: boolean;
  tier: Tier;
  /** True when the judge was too unsure and the thread's own model was kept. */
  pinned: boolean;
  reasons: string[];
}

const clampTier = (n: number): Tier => Math.max(0, Math.min(3, Math.round(n))) as Tier;

function effortIndex(e: string | undefined): number {
  const i = EFFORTS.indexOf(e as EffortLevel);
  return i < 0 ? 2 : i;
}

/** Nearest effort the candidate actually supports (its list, or the full ladder when the CLI does not say). */
function fitEffort(candidate: Candidate, wanted: EffortLevel): string | undefined {
  const supported = candidate.efforts.length ? candidate.efforts : [];
  if (!supported.length) return undefined;
  if (supported.includes(wanted)) return wanted;
  const w = effortIndex(wanted);
  let best: string | undefined;
  let bestD = Infinity;
  for (const s of supported) {
    const d = Math.abs(effortIndex(s) - w) + (effortIndex(s) > w ? 0.5 : 0); // prefer rounding down
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

export function decide(input: DecisionInput): Decision {
  const { judgments: j, policy, current } = input;
  const reasons: string[] = [];
  const currentLadder = input.ladders[current.backend] ?? [];
  const currentCandidate = currentLadder.find((c) => c.model === current.model);
  const label = (c: Candidate | undefined) => (c ? c.label : current.model || "the CLI default");

  // 1. Confidence gate: a calibrated judge that is unsure keeps whatever the user last chose.
  if (input.source === "jev" && j.taskConfidence < policy.min_confidence) {
    reasons.push(`Jev was unsure what kind of task this is (${j.taskConfidence.toFixed(2)} < ${policy.min_confidence}); kept ${label(currentCandidate)}.`);
    return { backend: current.backend, model: current.model, effort: current.effort, fast: false, tier: currentCandidate?.tier ?? 2, pinned: true, reasons };
  }

  // 2. Target tier from complexity, nudged by reasoning need, risk, posture, and what the user taught us.
  let tier = j.complexity;
  reasons.push(`${j.task.replace(/_/g, " ")} · complexity ${j.complexity.toFixed(1)}/3${input.source === "heuristic" ? " (built-in heuristic, no Jev key)" : ""}.`);
  if (j.needsDeepReasoning >= 0.7) { tier += 1; reasons.push("Needs careful reasoning → one tier up."); }
  if (j.blastRadius >= 1.5) { tier += 1; reasons.push("Wide or hard-to-reverse effect → one tier up for care."); }
  if (j.task === "quick_answer" && j.complexity < 1.2) { tier = Math.min(tier, 0.4); reasons.push("A quick answer → smallest model."); }
  else if (j.wantsSpeed >= 0.7 && j.needsDeepReasoning < 0.5 && j.complexity < 1.2) { tier = Math.min(tier, 0.4); reasons.push("You asked for speed on a light task → smallest model."); }
  if (policy.posture === "economy") { tier -= 1; reasons.push("Posture: economy → one tier down."); }
  else if (policy.posture === "quality") { tier += 1; reasons.push("Posture: quality → one tier up."); }
  if (input.fitOffset) { tier += input.fitOffset; reasons.push(`Your past overrides for ${j.task.replace(/_/g, " ")} → ${input.fitOffset > 0 ? "+" : ""}${input.fitOffset.toFixed(1)} tier.`); }
  let target = clampTier(tier);
  if (input.premiumExhausted && target === 3) { target = 2; reasons.push("Daily premium-turn budget used up → capped at tier 2."); }

  // 3. Backend: stay put unless switching is allowed and it would not throw away the CLI session.
  let backend = current.backend;
  const canSwitch = policy.allow_backend_switch && (!current.hasSession || j.dependsOnPriorTurns < 0.4);
  if (canSwitch) {
    const options = (policy.allow_backends.length ? policy.allow_backends : [current.backend]).filter((b) => (input.ladders[b]?.length ?? 0) > 0);
    const reach = (b: BackendId) => Math.max(...(input.ladders[b] ?? []).map((c) => c.tier), -1);
    const currentReach = reach(current.backend);
    const better = options.find((b) => b !== current.backend && reach(b) >= target && currentReach < target);
    if (better) { backend = better; reasons.push(`${current.backend} lists no tier-${target} model; switched to ${better}.`); }
    else if (!currentLadder.length) {
      const any = options[0];
      if (any) { backend = any; reasons.push(`${current.backend} is unavailable; switched to ${any}.`); }
    }
  } else if (policy.allow_backend_switch && current.hasSession) reasons.push("This turn continues the conversation, so the backend stays to keep its session.");

  // 4. Model at the target tier on that backend.
  const rungs = input.ladders[backend] ?? [];
  const candidate = pick(rungs, target);
  if (!candidate) {
    reasons.push("No model list available; kept the current model.");
    return { backend: current.backend, model: current.model, effort: current.effort, fast: false, tier: target, pinned: true, reasons };
  }
  if (candidate.tier < target) reasons.push(`No tier-${target} model on ${backend}; using the highest available (${candidate.label}).`);

  // 5. Effort: tier sets the base; deep reasoning bumps, a speed signal drops, policy caps.
  const base: EffortLevel[] = ["low", "medium", "high", "xhigh"];
  let e = effortIndex(base[candidate.tier]!);
  if (j.needsDeepReasoning >= 0.7) e += 1;
  if (j.wantsSpeed >= 0.7 && j.needsDeepReasoning < 0.5) { e -= 1; reasons.push("You asked for speed → lower reasoning effort."); }
  const cap = effortIndex(policy.max_effort);
  if (e > cap) { e = cap; reasons.push(`Effort capped at ${policy.max_effort} by your limit.`); }
  if (input.premiumExhausted && e > effortIndex("high")) e = effortIndex("high");
  const wanted = EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, e))]!;
  const effort = fitEffort(candidate, wanted);

  // 6. Fast mode: only when the user signals speed, the task is not reasoning-heavy, and the model offers it.
  const fast = policy.allow_fast && j.wantsSpeed >= 0.6 && j.needsDeepReasoning < 0.5 && candidate.tier <= 1 && Boolean(candidate.fastTier || backend === "claude");
  if (fast) reasons.push("Fast mode: quick turnaround requested and the task is light.");

  return { backend, model: candidate.model, effort, fast, tier: candidate.tier, pinned: false, reasons };
}
