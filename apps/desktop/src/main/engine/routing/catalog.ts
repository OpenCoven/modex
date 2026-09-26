import type { BackendId, ModelInfo } from "../../../shared/types.js";

/**
 * The routing catalogue: every model a backend's CLI lists, placed on a capability ladder.
 *
 * Tier 0 = fastest/cheapest, 3 = most capable. The CLIs report names and descriptions but not
 * cost or capability, so tiers come from a small table of known families plus description
 * hints; unknown models land in the middle. The ladder is rebuilt from the live `model/list`
 * each time the catalogue refreshes, so new models appear without a Modex release.
 */
export type Tier = 0 | 1 | 2 | 3;

export interface Candidate {
  backend: BackendId;
  model: string;
  label: string;
  tier: Tier;
  efforts: string[];
  defaultEffort?: string;
  /** Service tier id that means "fast mode" for this model (Codex), if any. */
  fastTier?: string;
  isDefault?: boolean;
}

const KNOWN: { re: RegExp; tier: Tier }[] = [
  // Claude Code aliases and full ids. Aliases resolve to the newest model of each family.
  { re: /^(claude-)?haiku/, tier: 0 },
  { re: /^(claude-)?sonnet/, tier: 1 },
  { re: /^(claude-)?opus/, tier: 2 },
  { re: /^(claude-)?fable/, tier: 3 },
  // Codex catalogue (Sept 2026). Ordering within GPT-6 follows the CLI's own descriptions when present.
  { re: /^gpt-5\.5/, tier: 0 },
  { re: /^gpt-5\.6/, tier: 1 },
  { re: /^gpt-6-luna/, tier: 2 },
  { re: /^gpt-6-sol/, tier: 2 },
  { re: /^gpt-6-astra/, tier: 3 },
  { re: /mini|nano|small|lite|flash/, tier: 0 },
  { re: /^mock$/, tier: 1 },
];

/** Description hints only move a model when the name is unknown. */
function hintTier(description: string | undefined): Tier | null {
  const d = (description ?? "").toLowerCase();
  if (!d) return null;
  if (/most (capable|intelligent|powerful)|frontier|hardest|complex/.test(d)) return 3;
  if (/fast(est)?|cheap|quick|lightweight|latency|everyday|simple tasks/.test(d)) return 0;
  return null;
}

export function tierOf(model: ModelInfo): Tier {
  const id = model.id.toLowerCase();
  for (const k of KNOWN) if (k.re.test(id)) return k.tier;
  return hintTier(model.description) ?? 2;
}

export function toCandidate(backend: BackendId, m: ModelInfo): Candidate {
  const fastTier = m.serviceTiers?.find((t) => /^fast$|fast/i.test(t));
  return { backend, model: m.id, label: m.label, tier: tierOf(m), efforts: m.efforts ?? [], defaultEffort: m.defaultEffort, fastTier, isDefault: m.isDefault };
}

/** Candidates for a backend, lowest tier first; within a tier the CLI default wins. */
export function ladder(backend: BackendId, models: ModelInfo[]): Candidate[] {
  return models.map((m) => toCandidate(backend, m)).sort((a, b) => a.tier - b.tier || Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
}

/** The best candidate at or below `tier`; if the ladder has nothing that low, its lowest rung. */
export function pick(rungs: Candidate[], tier: Tier): Candidate | undefined {
  if (!rungs.length) return undefined;
  const atOrBelow = rungs.filter((c) => c.tier <= tier);
  if (!atOrBelow.length) return rungs[0];
  const top = atOrBelow[atOrBelow.length - 1]!.tier;
  return atOrBelow.find((c) => c.tier === top && c.isDefault) ?? atOrBelow.find((c) => c.tier === top);
}
