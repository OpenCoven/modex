import type { BackendId, Mode, ThreadItem } from "../../../shared/types.js";
import type { JevAnswer, JevQuestion, JevTransport } from "./jev.js";

/**
 * The routing judge: a fixed, versioned set of narrow questions Jev answers about one request.
 * Code owns everything else — the catalogue of models, the policy that maps judgments to a
 * choice, and the learning loop. Changing the policy never requires re-asking Jev.
 *
 * Jev reads instructions literally and loses accuracy on large, unrelated state, so the state
 * sent is a compact digest: the request, a few recent turns, and a handful of project facts.
 * No file contents are ever sent.
 */
export const QUESTION_SET_VERSION = 1;

export type TaskKind = "quick_answer" | "small_edit" | "bug_fix" | "feature" | "refactor" | "investigation" | "review" | "ops" | "unclear";

export const TASKS: Record<TaskKind, string> = {
  quick_answer: "A question about the code or tooling that needs an explanation or a short answer, not a change.",
  small_edit: "A small, well-specified change: a rename, a typo, a config value, a one-file tweak, or a tiny addition following an existing pattern.",
  bug_fix: "Something is broken or failing and the user wants it fixed; the failure is described or reproducible.",
  feature: "New behaviour or a new component that must be designed and built across the codebase.",
  refactor: "Restructuring, migrating, or redesigning existing code or architecture without primarily adding features.",
  investigation: "An open-ended look into why something happens, a performance or flakiness problem, or a diagnosis before any fix is known.",
  review: "Reviewing, auditing, or assessing existing code, a diff, or a plan for problems.",
  ops: "Git, CI, releases, dependencies, scripts, environment, or repository housekeeping rather than product code.",
  unclear: "The request is too vague or incomplete to tell what kind of work it is.",
};

export const COMPLEXITY_LEVELS = [
  "A one-step change or answer: a single obvious edit, a rename, a quick explanation, or a direct factual question about the code.",
  "A contained change in one or two files following an existing pattern, with a clear finish line.",
  "Work spanning several files or components that needs the codebase read first, a design decision, or a failure reproduced before it can be fixed.",
  "Cross-cutting work: a new subsystem, an architecture change, a migration, a tricky concurrency or performance problem, or an open-ended investigation with no clear finish line.",
];

export const BLAST_RADIUS_LEVELS = [
  "Touches one file or nothing at all; trivially reversible.",
  "Touches several files or configuration; reversible with git.",
  "Could delete data, rewrite git history, change public interfaces or infrastructure, or run commands that affect systems outside the repository.",
];

export interface RoutingState {
  request: string;
  thread: { backend: BackendId; model: string; mode: Mode; plan: boolean; turns: number };
  recent: { role: "user" | "assistant" | "tool"; text: string }[];
  project: { name: string; branch?: string | null; changedFiles?: number };
}

export interface Judgments {
  task: TaskKind;
  taskConfidence: number;
  taskProbabilities: Record<string, number>;
  /** 0–3, probability-weighted. */
  complexity: number;
  complexityConfidence: number;
  /** 0–2, probability-weighted. */
  blastRadius: number;
  /** Nouls, 0–1. */
  wantsSpeed: number;
  needsDeepReasoning: number;
  dependsOnPriorTurns: number;
}

export type JudgeSource = "jev" | "heuristic";

/** Builds the compact state for one request. Clips text so unrelated detail cannot swamp the judge. */
export function stateFor(input: { text: string; backend: BackendId; model: string; mode: Mode; plan: boolean; items: ThreadItem[]; project: { name: string; branch?: string | null; changedFiles?: number } }): RoutingState {
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  const recent: RoutingState["recent"] = [];
  for (const it of input.items.slice(-12)) {
    if (it.kind === "user") recent.push({ role: "user", text: clip(it.text, 300) });
    else if (it.kind === "assistant" && it.text.trim()) recent.push({ role: "assistant", text: clip(it.text, 240) });
    else if (it.kind === "tool") recent.push({ role: "tool", text: clip(it.title, 120) });
  }
  return {
    request: clip(input.text, 4000),
    thread: { backend: input.backend, model: input.model, mode: input.mode, plan: input.plan, turns: input.items.filter((i) => i.kind === "user").length },
    recent: recent.slice(-6),
    project: input.project,
  };
}

/** The question set. `recent` empty → the continuity question is not asked (code already knows the answer). */
export function questionsFor(state: RoutingState): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {
    task: { type: "choice", instructions: "What kind of work is the user asking the coding agent to do in `request`? Judge the request itself, using `recent` only to resolve references.", criteria: { ...TASKS } },
    complexity: { type: "score", instructions: "How much work and judgment will a capable coding agent need to complete `request` well?", criteria: [...COMPLEXITY_LEVELS] },
    blast_radius: { type: "score", instructions: "If the agent carries out `request`, how wide and how reversible is its effect on the repository and the systems around it?", criteria: [...BLAST_RADIUS_LEVELS] },
    wants_speed: {
      type: "noul",
      instructions: "Does the user signal in `request` that a quick turnaround matters more than thoroughness this time?",
      criteria: { true: "The request asks for something quick, rough, small, a draft, a first pass, or says not to overthink it.", false: "No such signal, or the request asks for care, thoroughness, correctness, or a full solution." },
    },
    needs_deep_reasoning: {
      type: "noul",
      instructions: "Does doing `request` well require careful multi-step reasoning about how parts of the code interact, rather than a lookup or a routine edit?",
      criteria: { true: "The agent must understand interactions, trade-offs, invariants, or root causes before acting.", false: "The agent can act from the request and the visible code with little deliberation." },
    },
  };
  if (state.recent.length > 0) {
    q.depends_on_prior_turns = {
      type: "noul",
      instructions: "Does `request` rely on the earlier conversation in `recent` to make sense — for example it says 'that', 'the same', 'again', 'as above', or continues unfinished work?",
      criteria: { true: "The request cannot be carried out correctly without the earlier turns.", false: "The request stands on its own." },
    };
  }
  return q;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** Turns a Jev response into Judgments. Throws when the essential answers are missing or malformed. */
export function judgmentsFrom(answers: Record<string, JevAnswer | undefined>, state: RoutingState): Judgments {
  const task = answers.task;
  const complexity = answers.complexity;
  const blast = answers.blast_radius;
  if (!task || task.type !== "choice" || !(task.choice in TASKS)) throw new Error("Jev returned no usable task choice");
  if (!complexity || complexity.type !== "score" || typeof complexity.score !== "number") throw new Error("Jev returned no usable complexity score");
  const noul = (a: JevAnswer | undefined, fallback: number) => (a && a.type === "noul" ? num(a.noul, fallback) : fallback);
  const probs: Record<string, number> = {};
  for (const [k, v] of Object.entries(task.probabilities ?? {})) if (k in TASKS) probs[k] = num(v);
  return {
    task: task.choice as TaskKind,
    taskConfidence: num(task.confidence, probs[task.choice] ?? 0),
    taskProbabilities: probs,
    complexity: Math.min(3, Math.max(0, complexity.score)),
    complexityConfidence: num(complexity.confidence, 0),
    blastRadius: blast && blast.type === "score" && typeof blast.score === "number" ? Math.min(2, Math.max(0, blast.score)) : 0,
    wantsSpeed: noul(answers.wants_speed, 0),
    needsDeepReasoning: noul(answers.needs_deep_reasoning, 0.5),
    dependsOnPriorTurns: state.recent.length ? noul(answers.depends_on_prior_turns, 0.5) : 0,
  };
}

export async function judgeWithJev(state: RoutingState, transport: JevTransport, model: string, signal?: AbortSignal): Promise<Judgments> {
  const res = await transport({ state, model, questions: questionsFor(state) }, signal);
  return judgmentsFrom(res.answers, state);
}

// ---------------------------------------------------------------------------
// Offline judge: deterministic keyword + shape heuristics so Auto still works with no key.
// Deliberately simple; the UI labels its verdicts "heuristic", never "Jev".
// ---------------------------------------------------------------------------

const KW: Record<Exclude<TaskKind, "unclear">, RegExp> = {
  quick_answer: /\b(what|why|how|where|which|explain|does|is there|do we|should i|tell me|difference between)\b/i,
  small_edit: /\b(rename|typo|tweak|bump|change the (?:name|label|text|color|colour|value)|one[- ]liner|small|tiny|quick fix|update the (?:readme|comment|docstring))\b/i,
  bug_fix: /\b(bug|broken|fails?|failing|crash|error|exception|regression|doesn'?t work|not working|wrong|fix)\b/i,
  feature: /\b(add|implement|build|create|introduce|support|new (?:feature|component|page|endpoint|command)|wire up)\b/i,
  refactor: /\b(refactor|restructure|migrate|migration|rewrite|extract|split|consolidate|architecture|redesign|clean ?up)\b/i,
  investigation: /\b(investigate|diagnose|figure out|root cause|flaky|slow|performance|profil|why does|intermittent|look into)\b/i,
  review: /\b(review|audit|assess|critique|look over|check (?:this|the) (?:diff|pr|code)|security review)\b/i,
  ops: /\b(git|commit|rebase|merge|branch|ci|workflow|release|publish|deploy|dependenc|npm|package\.json|lint|prettier|worktree|\.github)\b/i,
};

export function judgeHeuristically(state: RoutingState): Judgments {
  const text = state.request;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const scores: Record<string, number> = {};
  for (const [k, re] of Object.entries(KW)) {
    const m = text.match(new RegExp(re.source, re.flags + "g"));
    scores[k] = m ? m.length : 0;
  }
  // "fix" alone is weak evidence of a bug; questions ending in "?" lean towards answers.
  if (/\?\s*$/.test(text)) scores.quick_answer = (scores.quick_answer ?? 0) + 1.5;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  const task: TaskKind = !top || top[1] === 0 ? (words < 4 ? "unclear" : "feature") : (top[0] as TaskKind);
  const probs: Record<string, number> = {};
  for (const [k, v] of ranked) probs[k] = total ? v / total : 0;
  if (!total) probs[task] = 1;
  const taskConfidence = total ? (top![1] / total) * Math.min(1, 0.5 + total / 6) : 0.35;

  const long = words > 120 ? 1 : words > 45 ? 0.5 : 0;
  const multi = /\b(and|then|also|across|all|every|each|throughout)\b/gi.test(text) ? 0.5 : 0;
  const base: Record<TaskKind, number> = { quick_answer: 0.4, small_edit: 0.6, bug_fix: 1.6, feature: 2.0, refactor: 2.5, investigation: 2.3, review: 1.5, ops: 1.0, unclear: 1.5 };
  const complexity = Math.min(3, base[task] + long + multi);
  const risky = /\b(delete|drop|rm -rf|force[- ]push|reset --hard|prod(?:uction)?|deploy|migrat|schema|public api|breaking|secrets?|credentials?)\b/i.test(text);
  const blastRadius = risky ? 1.8 : complexity >= 2 ? 1.0 : 0.3;
  const wantsSpeed = /\b(quick(?:ly)?|fast|asap|just|simply|rough|draft|first pass|don'?t overthink|no need to be thorough|small)\b/i.test(text) ? 0.8 : 0.15;
  const careful = /\b(careful|thorough|correct|robust|production|edge cases?|race|concurren|deadlock|perf(?:ormance)?|memory|security|invariant)\b/i.test(text);
  const needsDeepReasoning = careful ? 0.85 : complexity >= 2.2 ? 0.7 : complexity >= 1.5 ? 0.45 : 0.15;
  const dependsOnPriorTurns = state.recent.length === 0 ? 0 : /\b(that|this|it|same|again|above|previous|earlier|continue|also|the other|now)\b/i.test(text) && words < 40 ? 0.75 : 0.2;
  return { task, taskConfidence, taskProbabilities: probs, complexity, complexityConfidence: 0.5, blastRadius, wantsSpeed, needsDeepReasoning, dependsOnPriorTurns };
}
