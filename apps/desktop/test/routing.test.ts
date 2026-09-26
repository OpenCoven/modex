import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { judgeHeuristically, judgmentsFrom, questionsFor, stateFor, TASKS, type Judgments } from "../src/main/engine/routing/judge.js";
import { decide, type DecisionInput } from "../src/main/engine/routing/policy.js";
import { ladder, pick, tierOf, type Candidate } from "../src/main/engine/routing/catalog.js";
import { Fit, OVERRIDE_STEP } from "../src/main/engine/routing/fit.js";
import { Router } from "../src/main/engine/routing/router.js";
import { httpTransport, JevError, resetKeyCache, resolveTypesafeKey, type JevResponse } from "../src/main/engine/routing/jev.js";
import { DEFAULT_ROUTING, type ModelInfo, type RoutingPolicy, type Thread } from "../src/shared/types.js";
import { tmpdir } from "./helpers.js";

const state = (text: string, recent: { role: "user" | "assistant" | "tool"; text: string }[] = []) => ({ request: text, thread: { backend: "codex" as const, model: "", mode: "agent" as const, plan: false, turns: recent.length }, recent, project: { name: "demo" } });

// ---------------------------------------------------------------- judge

test("heuristic judge: task kinds, complexity, risk, and speed from plain requests", () => {
  const j = (t: string, recent: { role: "user" | "assistant" | "tool"; text: string }[] = []) => judgeHeuristically(state(t, recent));
  assert.equal(j("Rename foo to bar in utils.ts").task, "small_edit");
  assert.ok(j("Rename foo to bar in utils.ts").complexity < 1.5);
  assert.equal(j("Why does the build fail on CI?").task, "quick_answer");
  assert.equal(j("Investigate the flaky test in runner.test.ts and find the root cause").task, "investigation");
  assert.equal(j("Implement a new settings page with routing options and add tests").task, "feature");
  assert.equal(j("Review this diff for security problems").task, "review");
  assert.equal(j("Rebase the branch and open a PR").task, "ops");
  assert.ok(j("delete the old migrations and force-push the cleanup").blastRadius >= 1.5, "destructive words raise blast radius");
  const quick = j("quick: bump the version");
  assert.ok(quick.wantsSpeed >= 0.7);
  assert.equal(quick.task, "small_edit");
  assert.ok(j("Make the cache concurrent-safe; be careful about the race on eviction").needsDeepReasoning >= 0.8);
  assert.equal(j("do it").task, "unclear");
  assert.equal(j("now do the same for the other file", [{ role: "user", text: "rename x" }]).dependsOnPriorTurns, 0.75);
  assert.equal(j("now do the same for the other file").dependsOnPriorTurns, 0, "no history → cannot depend on it");
});

test("question set: one request, closed task set, continuity only asked when there is history", () => {
  const none = questionsFor(state("x"));
  assert.deepEqual(Object.keys(none), ["task", "complexity", "blast_radius", "wants_speed", "needs_deep_reasoning"]);
  assert.equal(none.task!.type, "choice");
  assert.deepEqual(Object.keys((none.task as { criteria: Record<string, string> }).criteria), Object.keys(TASKS));
  assert.equal((none.complexity as { criteria: string[] }).criteria.length, 4);
  const some = questionsFor(state("again", [{ role: "user", text: "hi" }]));
  assert.ok("depends_on_prior_turns" in some);
});

test("stateFor digests the transcript without file contents and clips long text", () => {
  const items: Parameters<typeof stateFor>[0]["items"] = [
    { id: "1", kind: "user", text: "a".repeat(500), at: "" },
    { id: "2", kind: "tool", name: "Bash", title: "$ cat secrets.env", args: { command: "cat secrets.env" }, output: "TOKEN=abc", status: "done", at: "" },
    { id: "3", kind: "assistant", text: "done", at: "" },
  ];
  const s = stateFor({ text: "x".repeat(5000), backend: "claude", model: "opus", mode: "chat", plan: true, items, project: { name: "p", branch: "main" } });
  assert.equal(s.request.length, 4001);
  assert.equal(s.recent.length, 3);
  assert.equal(s.recent[0]!.text.length, 301);
  assert.equal(s.recent[1]!.text, "$ cat secrets.env", "tool titles only, never output");
  assert.equal(JSON.stringify(s).includes("TOKEN=abc"), false);
  assert.equal(s.thread.turns, 1);
});

test("judgmentsFrom reads Jev's answer shapes and rejects missing essentials", () => {
  const st = state("fix the crash", [{ role: "user", text: "earlier" }]);
  const j = judgmentsFrom({
    task: { type: "choice", choice: "bug_fix", probabilities: { bug_fix: 0.8, feature: 0.2, bogus: 1 }, confidence: 0.8 },
    complexity: { type: "score", score: 1.7, probabilities: { "1": 0.3, "2": 0.7 }, confidence: 0.7 },
    blast_radius: { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 },
    wants_speed: { type: "noul", noul: 0.1 },
    needs_deep_reasoning: { type: "noul", noul: 0.65 },
    depends_on_prior_turns: { type: "noul", noul: 0.9 },
  }, st);
  assert.equal(j.task, "bug_fix");
  assert.equal(j.taskConfidence, 0.8);
  assert.deepEqual(Object.keys(j.taskProbabilities), ["bug_fix", "feature"], "unknown option ids are dropped");
  assert.equal(j.complexity, 1.7);
  assert.equal(j.dependsOnPriorTurns, 0.9);
  assert.throws(() => judgmentsFrom({ complexity: { type: "score", score: 1, probabilities: {}, confidence: 1 } }, st), /no usable task/);
  assert.throws(() => judgmentsFrom({ task: { type: "choice", choice: "nope", probabilities: {}, confidence: 1 } }, st), /no usable task/);
});

// ---------------------------------------------------------------- catalogue

const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, ...extra });

test("catalogue: known families land on their tier, descriptions hint the rest, ladders sort", () => {
  assert.equal(tierOf(m("haiku")), 0);
  assert.equal(tierOf(m("claude-sonnet-5")), 1);
  assert.equal(tierOf(m("opus")), 2);
  assert.equal(tierOf(m("fable")), 3);
  assert.equal(tierOf(m("gpt-5.5")), 0);
  assert.equal(tierOf(m("gpt-5.6-codex")), 1);
  assert.equal(tierOf(m("gpt-6-astra")), 3);
  assert.equal(tierOf(m("gpt-7-nova", { description: "Our most capable model for complex work" })), 3);
  assert.equal(tierOf(m("gpt-7-zip", { description: "Fastest and cheapest for everyday tasks" })), 0);
  assert.equal(tierOf(m("whatever")), 2);
  const rungs = ladder("codex", [m("gpt-6-astra", { isDefault: true, serviceTiers: ["default", "fast"] }), m("gpt-5.5", { serviceTiers: ["fast"] }), m("gpt-6-luna")]);
  assert.deepEqual(rungs.map((c) => c.model), ["gpt-5.5", "gpt-6-luna", "gpt-6-astra"]);
  assert.equal(rungs[0]!.fastTier, "fast");
  assert.equal(pick(rungs, 3)!.model, "gpt-6-astra");
  assert.equal(pick(rungs, 2)!.model, "gpt-6-luna");
  assert.equal(pick(rungs, 1)!.model, "gpt-5.5", "highest rung at or below the target");
  assert.equal(pick(ladder("codex", [m("gpt-6-luna")]), 0)!.model, "gpt-6-luna", "nothing lower → the lowest rung");
  assert.equal(pick([], 1), undefined);
});

// ---------------------------------------------------------------- policy

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];
const codexLadder = () => ladder("codex", [m("gpt-5.5", { efforts: CODEX_EFFORTS, serviceTiers: ["fast"] }), m("gpt-5.6-x", { efforts: CODEX_EFFORTS }), m("gpt-6-luna", { efforts: CODEX_EFFORTS }), m("gpt-6-astra", { efforts: CODEX_EFFORTS, isDefault: true })]);
const claudeLadder = () => ladder("claude", ["haiku", "sonnet", "opus", "fable"].map((id) => m(id, { efforts: ["low", "medium", "high", "xhigh", "max"] })));
const J = (over: Partial<Judgments> = {}): Judgments => ({ task: "small_edit", taskConfidence: 0.9, taskProbabilities: {}, complexity: 0.6, complexityConfidence: 0.8, blastRadius: 0.3, wantsSpeed: 0.1, needsDeepReasoning: 0.2, dependsOnPriorTurns: 0, ...over });
const D = (over: Partial<DecisionInput> = {}, policy: Partial<RoutingPolicy> = {}): DecisionInput => ({
  judgments: J(), source: "jev", policy: { ...DEFAULT_ROUTING, ...policy },
  current: { backend: "codex", model: "gpt-6-astra", effort: "high", hasSession: false },
  ladders: { codex: codexLadder(), claude: claudeLadder() }, fitOffset: 0, premiumExhausted: false, ...over,
});

test("policy: complexity sets the tier and effort; posture shifts it; every change leaves a reason", () => {
  const base = decide(D());
  assert.deepEqual([base.backend, base.model, base.effort, base.fast, base.pinned], ["codex", "gpt-5.6-x", "medium", false, false]);
  assert.match(base.reasons[0]!, /small edit · complexity 0\.6/);
  const eco = decide(D({}, { posture: "economy" }));
  assert.deepEqual([eco.model, eco.effort], ["gpt-5.5", "low"]);
  assert.ok(eco.reasons.some((r) => /economy/.test(r)));
  const q = decide(D({}, { posture: "quality" }));
  assert.equal(q.model, "gpt-6-luna");
  const feature = decide(D({ judgments: J({ task: "feature", complexity: 2.2, needsDeepReasoning: 0.9 }) }));
  assert.deepEqual([feature.model, feature.effort], ["gpt-6-astra", "xhigh"], "deep reasoning bumps a tier; max_effort caps at xhigh");
  assert.ok(feature.reasons.some((r) => /Effort capped at xhigh/.test(r)));
  const lifted = decide(D({ judgments: J({ task: "feature", complexity: 2.2, needsDeepReasoning: 0.9 }), current: { backend: "claude", model: "opus", hasSession: false } }, { max_effort: "max" }));
  assert.deepEqual([lifted.backend, lifted.model, lifted.effort], ["claude", "fable", "max"]);
  const risky = decide(D({ judgments: J({ complexity: 1.2, blastRadius: 1.8 }) }));
  assert.equal(risky.model, "gpt-6-luna", "hard-to-reverse work goes one tier up");
  const answer = decide(D({ judgments: J({ task: "quick_answer", complexity: 0.9 }) }));
  assert.deepEqual([answer.model, answer.effort], ["gpt-5.5", "low"]);
});

test("policy: fast mode needs a speed signal, a light task, and a model that offers it", () => {
  const fast = decide(D({ judgments: J({ complexity: 0.4, wantsSpeed: 0.9 }) }));
  assert.deepEqual([fast.model, fast.fast, fast.effort], ["gpt-5.5", true, "low"], "effort drops one but snaps to what the model lists");
  assert.equal(decide(D({ judgments: J({ complexity: 0.4, wantsSpeed: 0.9 }) }, { allow_fast: false })).fast, false);
  assert.equal(decide(D({ judgments: J({ complexity: 0.4, wantsSpeed: 0.9, needsDeepReasoning: 0.8 }) })).fast, false, "not when reasoning is needed");
  assert.equal(decide(D({ judgments: J({ complexity: 2.4, wantsSpeed: 0.9 }) })).fast, false, "not on big models");
  const claude = decide(D({ judgments: J({ complexity: 0.4, wantsSpeed: 0.9 }), current: { backend: "claude", model: "opus", hasSession: false } }));
  assert.deepEqual([claude.model, claude.fast], ["haiku", true]);
});

test("policy: an unsure Jev keeps the user's model; the heuristic's confidence is not gated", () => {
  const pinned = decide(D({ judgments: J({ taskConfidence: 0.4 }) }));
  assert.deepEqual([pinned.pinned, pinned.model, pinned.effort, pinned.fast], [true, "gpt-6-astra", "high", false]);
  assert.match(pinned.reasons[0]!, /unsure/);
  const heur = decide(D({ judgments: J({ taskConfidence: 0.4 }), source: "heuristic" }));
  assert.equal(heur.pinned, false);
  assert.match(heur.reasons[0]!, /built-in heuristic/);
});

test("policy: premium budget and learned offsets bound the tier", () => {
  const capped = decide(D({ judgments: J({ task: "refactor", complexity: 2.8, needsDeepReasoning: 0.9 }), premiumExhausted: true }));
  assert.deepEqual([capped.model, capped.effort], ["gpt-6-luna", "high"]);
  assert.ok(capped.reasons.some((r) => /premium-turn budget/.test(r)));
  const up = decide(D({ fitOffset: 1 }));
  assert.equal(up.model, "gpt-6-luna");
  assert.ok(up.reasons.some((r) => /past overrides/.test(r)));
  assert.equal(decide(D({ fitOffset: -1 })).model, "gpt-5.5");
});

test("policy: backend switching only when allowed, only without a session to lose, only when needed", () => {
  const stuck = decide(D({ judgments: J({ task: "feature", complexity: 2.6, needsDeepReasoning: 0.9 }), current: { backend: "claude", model: "haiku", hasSession: false }, ladders: { claude: ladder("claude", [m("haiku")]), codex: codexLadder() } }));
  assert.deepEqual([stuck.backend, stuck.model], ["claude", "haiku"], "off by default: stays even when the ladder cannot reach the tier");
  const moved = decide(D({ judgments: J({ task: "feature", complexity: 2.6, needsDeepReasoning: 0.9 }), current: { backend: "claude", model: "haiku", hasSession: false }, ladders: { claude: ladder("claude", [m("haiku")]), codex: codexLadder() } }, { allow_backend_switch: true }));
  assert.deepEqual([moved.backend, moved.model], ["codex", "gpt-6-astra"]);
  const kept = decide(D({ judgments: J({ task: "feature", complexity: 2.6, needsDeepReasoning: 0.9, dependsOnPriorTurns: 0.9 }), current: { backend: "claude", model: "haiku", hasSession: true }, ladders: { claude: ladder("claude", [m("haiku")]), codex: codexLadder() } }, { allow_backend_switch: true }));
  assert.equal(kept.backend, "claude");
  assert.ok(kept.reasons.some((r) => /keep its session/.test(r)));
  const able = decide(D({ judgments: J({ task: "feature", complexity: 2.6, needsDeepReasoning: 0.9 }), current: { backend: "claude", model: "haiku", hasSession: false } }, { allow_backend_switch: true }));
  assert.deepEqual([able.backend, able.model], ["claude", "fable"], "no switch when the current backend reaches the tier");
  const down = decide(D({ current: { backend: "claude", model: "opus", hasSession: false }, ladders: { claude: [], codex: codexLadder() } }, { allow_backend_switch: true }));
  assert.deepEqual([down.backend, down.model], ["codex", "gpt-5.6-x"], "an unavailable backend fails over");
  const none = decide(D({ ladders: {} }));
  assert.deepEqual([none.pinned, none.model], [true, "gpt-6-astra"]);
});

// ---------------------------------------------------------------- fit

test("fit: overrides move a task's offset in steps, failures nudge up, premium counts per day, and it persists", () => {
  const file = path.join(tmpdir("modex-fit-"), "routing-fit.json");
  let day = "2026-09-25";
  const fit = new Fit(file, () => day);
  const rec = { threadId: "t1", task: "small_edit" as const, source: "jev" as const, backend: "codex", model: "gpt-5.5", fast: false, tier: 0, confidence: 0.9, premium: false };
  fit.recordRoute(rec);
  assert.equal(fit.recordOverride("t1", 0), undefined, "same tier is not an override");
  assert.equal(fit.recordOverride("t1", 2)!.task, "small_edit");
  assert.equal(fit.recordOverride("t1", 3), undefined, "one override per route");
  assert.equal(fit.snapshot().tasks.small_edit!.overridesUp, 1);
  assert.ok(Math.abs(fit.snapshot().tasks.small_edit!.offset - OVERRIDE_STEP * 2) < 1e-9, "two tiers up counts double, capped there");
  assert.equal(fit.offsetFor("small_edit"), 0.5, "applied offsets round to half tiers");
  fit.recordRoute(rec);
  fit.recordOutcome("t1", "failed");
  assert.equal(fit.snapshot().tasks.small_edit!.failures, 1);
  fit.recordRoute(rec);
  fit.recordOutcome("t1", "completed");
  assert.equal(fit.snapshot().tasks.small_edit!.completions, 1);
  fit.recordRoute({ ...rec, premium: true });
  fit.recordRoute({ ...rec, premium: true });
  assert.equal(fit.premiumToday(), 2);
  day = "2026-09-26";
  assert.equal(fit.premiumToday(), 0, "a new day resets the premium count");
  const again = new Fit(file, () => day);
  assert.equal(again.snapshot().history.length, 5);
  assert.equal(again.snapshot().tasks.small_edit!.overridesUp, 1);
  fit.recordRoute({ ...rec, tier: 2 });
  fit.recordOverride("t1", 0);
  assert.equal(fit.snapshot().tasks.small_edit!.overridesDown, 1);
  fit.reset();
  assert.deepEqual(new Fit(file, () => day).snapshot().tasks, {});
});

// ---------------------------------------------------------------- router

const thread = (over: Partial<Thread> = {}): Thread => ({ id: "th1", projectId: "p", title: "t", createdAt: "", updatedAt: "", cwd: "/w", backend: "codex", mode: "agent", plan: false, model: "gpt-6-astra", effort: "high", status: "idle", auto: true, ...over });
const listModels = async (b: string) => ({ models: b === "codex" ? [m("gpt-5.5", { efforts: CODEX_EFFORTS, serviceTiers: ["fast"] }), m("gpt-5.6-x", { efforts: CODEX_EFFORTS }), m("gpt-6-astra", { efforts: CODEX_EFFORTS, isDefault: true })] : [] });
const jevAnswers = (task: string, complexity: number, over: Partial<JevResponse["answers"]> = {}): JevResponse => ({
  model: "jev-1.13.0",
  answers: {
    task: { type: "choice", choice: task, probabilities: { [task]: 0.86 }, confidence: 0.86 },
    complexity: { type: "score", score: complexity, probabilities: {}, confidence: 0.7 },
    blast_radius: { type: "score", score: 0.3, probabilities: {}, confidence: 0.9 },
    wants_speed: { type: "noul", noul: 0.1 },
    needs_deep_reasoning: { type: "noul", noul: 0.2 },
    ...over,
  },
});

test("router: Jev judgments become a receipt item, the fit records the route, and status reports live", async () => {
  const home = tmpdir("modex-home-");
  const sent: unknown[] = [];
  const router = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async (req) => { sent.push(req); return jevAnswers("small_edit", 0.6); } });
  const r = await router.route({ thread: thread(), text: "rename a to b", items: [], project: { name: "demo" } });
  assert.equal(r.source, "jev");
  assert.deepEqual([r.item.kind, r.item.backend, r.item.model, r.item.effort, r.item.fast, r.item.task, r.item.confidence, r.item.pinned], ["route", "codex", "gpt-5.6-x", "medium", false, "small_edit", 0.86, false]);
  assert.equal((sent[0] as { model: string }).model, "jev-latest");
  assert.equal(typeof (sent[0] as { questions: Record<string, unknown> }).questions.task, "object");
  assert.equal(fs.existsSync(path.join(home, "app", "routing-fit.json")), true);
  const s = await router.status();
  assert.deepEqual([s.live, s.keySource, s.fit.routes, s.fit.premiumToday], [true, "env", 1, 0]);
  // premium turns count against the daily budget and cap the next pick
  const budget = new Router({ home, policy: () => ({ ...DEFAULT_ROUTING, premium_turns_per_day: 1 }), listModels, transport: async () => jevAnswers("feature", 2.6, { needs_deep_reasoning: { type: "noul", noul: 0.9 } }) });
  const a = await budget.route({ thread: thread(), text: "big feature", items: [], project: { name: "demo" } });
  assert.deepEqual([a.item.model, a.item.effort], ["gpt-6-astra", "xhigh"]);
  const b = await budget.route({ thread: thread(), text: "another big feature", items: [], project: { name: "demo" } });
  assert.deepEqual([b.item.model, b.item.effort], ["gpt-5.6-x", "high"]);
  assert.ok(b.item.reasons.some((x) => /budget/.test(x)));
  // a hand-picked model teaches the fit
  const learned = await budget.noteOverride(thread(), "gpt-6-astra");
  assert.deepEqual(learned, { task: "feature", from: 1, to: 3 });
  assert.equal((await budget.status()).fit.tasks.feature!.overridesUp, 1);
});

test("router: Jev failing or absent falls back to the heuristic and says so in the receipt", async () => {
  const home = tmpdir("modex-home-");
  const failing = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async () => { throw new JevError("TypeSafe is overloaded.", "overloaded", 529); } });
  const r = await failing.route({ thread: thread(), text: "quick: bump the version", items: [], project: { name: "demo" } });
  assert.equal(r.source, "heuristic");
  assert.match(r.item.reasons[0]!, /Jev unavailable — TypeSafe is overloaded\. \(overloaded\)/);
  assert.deepEqual([r.item.model, r.item.fast], ["gpt-5.5", true]);
  // A rejected key or an empty credit balance turns Jev off for the session instead of retrying every turn.
  let calls = 0;
  const broke = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async () => { calls++; throw new JevError("The TypeSafe organization has no API credits.", "billing", 402); } });
  const first = await broke.route({ thread: thread(), text: "hi", items: [], project: { name: "demo" } });
  assert.match(first.item.reasons[0]!, /no API credits\. \(billing\)/);
  const second = await broke.route({ thread: thread(), text: "hi again", items: [], project: { name: "demo" } });
  assert.equal(calls, 1);
  assert.match(second.item.reasons[0]!, /Jev is off for this session — The TypeSafe organization has no API credits\./);
  const bs = await broke.status();
  assert.equal(bs.live, false);
  assert.match(bs.detail!, /credits/);
  const offline = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: null });
  const o = await offline.route({ thread: thread(), text: "why is this slow?", items: [], project: { name: "demo" } });
  assert.match(o.item.reasons[0]!, /No TypeSafe API key/);
  assert.equal((await offline.status()).live, false);
  assert.match((await offline.status()).detail!, /No TYPESAFE_API_KEY found/);
  // an aborted turn (user pressed Stop while judging) propagates the signal to the transport
  const ac = new AbortController();
  const aborting = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async (_req, signal) => { ac.abort(); assert.equal(signal?.aborted, true); throw new JevError("timed out", "timeout"); } });
  const x = await aborting.route({ thread: thread(), text: "hi", items: [], project: { name: "demo" } }, ac.signal);
  assert.equal(x.source, "heuristic");
});

// ---------------------------------------------------------------- jev client

test("jev client: key resolution never hits the login shell when disabled; the HTTP transport maps errors", async () => {
  resetKeyCache();
  assert.deepEqual(await resolveTypesafeKey({ TYPESAFE_API_KEY: " k1 " }), { key: "k1", source: "env" });
  assert.deepEqual(await resolveTypesafeKey({ MODEX_NO_LOGIN_PATH: "1" }), { key: null, source: "none" });
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = httpTransport("secret", { fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(jevAnswers("ops", 1)), { status: 200 }); }) as unknown as typeof fetch });
  const res = await ok({ state: { request: "x" }, model: "jev-latest", questions: {} });
  assert.equal((res.answers.task as { choice: string }).choice, "ops");
  assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer secret");
  assert.equal(JSON.parse(calls[0]!.init.body as string).model, "jev-latest");
  const unauthorized = httpTransport("bad", { fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch });
  await assert.rejects(unauthorized({ state: "s", model: "jev-latest", questions: {} }), (e: JevError) => e.code === "auth");
  const garbage = httpTransport("k", { fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(garbage({ state: "s", model: "jev-latest", questions: {} }), (e: JevError) => e.code === "bad_response");
  const slow = httpTransport("k", { timeoutMs: 5, fetchImpl: ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch });
  await assert.rejects(slow({ state: "s", model: "jev-latest", questions: {} }), (e: JevError) => e.code === "timeout");
});
