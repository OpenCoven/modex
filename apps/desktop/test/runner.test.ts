import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { MockBackend } from "../src/main/engine/backends/mock.js";
import type { Backend, TurnOptions, TurnResult, TurnSink } from "../src/main/engine/backends/types.js";
import type { Thread, ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { MockProvider, type MockStep } from "@modex/core";
import { gitRepo, tmpdir, writeScript } from "./helpers.js";

function harness(steps: MockStep[] = []) {
  const home = tmpdir("modex-home-");
  const store = new Store(home);
  store.updateSettings({ default_backend: "mock", mock_script: writeScript(steps) });
  const events: ThreadEvent[] = [];
  const backends = { mock: new MockBackend(() => store.settings.mock_script, home, 0) };
  return { home, store, events, emit: (e: ThreadEvent) => events.push(e), backends };
}

const PATCH = "*** Begin Patch\n*** Add File: NOTE.md\n+hello from modex\n*** End Patch";

test("agent mode: a prompt runs tools, edits the project, emits items, persists, and sets the title", async () => {
  const h = harness([
    { thinking: "Check the tree first.", content: "Looking.", tool_calls: [{ name: "shell", arguments: { command: "ls" } }] },
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "Added NOTE.md." },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "agent" });
  assert.equal(thread.cwd, repo);
  await runner.send(thread.id, "add a note file please");
  assert.equal(fs.readFileSync(path.join(repo, "NOTE.md"), "utf8"), "hello from modex\n");
  const items = runner.items(thread.id);
  assert.deepEqual(items.map((i) => i.kind), ["user", "thinking", "assistant", "tool", "tool", "assistant"]);
  const think = items[1] as { text: string; status: string; durationMs?: number };
  assert.equal(think.text, "Check the tree first.");
  assert.equal(think.status, "done");
  assert.ok(think.durationMs != null && think.durationMs >= 0);
  // streaming: the first assistant item was created empty, grew via item_update, and ended with the full text
  const first = items[2] as { id: string; text: string };
  assert.equal(first.text, "Looking.");
  const updates = h.events.filter((e) => e.type === "item_update" && e.id === first.id).map((e) => (e as { patch: { text?: string } }).patch.text);
  assert.ok(updates.length >= 1 && updates.at(-1) === "Looking.");
  assert.equal((h.events.find((e) => e.type === "item" && (e as { item: ThreadItem }).item.id === first.id) as { item: { text: string } }).item.text, "");
  const tools = items.filter((i): i is Extract<ThreadItem, { kind: "tool" }> => i.kind === "tool");
  assert.equal(tools[0]!.title, "$ ls");
  assert.equal(tools[0]!.status, "done");
  assert.ok(tools[0]!.output?.includes("README.md"));
  assert.equal(tools[1]!.title, "edit NOTE.md");
  assert.equal(tools[1]!.ok, true);
  assert.equal(runner.status(thread.id), "idle");
  assert.equal(h.store.thread(thread.id)?.title, "add a note file please");
  assert.ok(h.store.thread(thread.id)?.sessionHandle);
  // statuses went running → idle; items were persisted for restart
  const statuses = h.events.filter((e) => e.type === "status").map((e) => (e as { status: string }).status);
  assert.deepEqual(statuses, ["running", "idle"]);
  assert.equal(new Store(h.home).items(thread.id).length, items.length);
});

test("chat mode: edits pause on an approval card; answering resumes the turn", async () => {
  const h = harness([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "ok" },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "chat" });
  const done = runner.send(thread.id, "write NOTE.md");
  const approval = await waitFor(() => runner.items(thread.id).find((i) => i.kind === "approval"));
  assert.equal(runner.status(thread.id), "waiting");
  assert.match((approval as { question: string }).question, /Allow add NOTE.md/);
  runner.answer(thread.id, approval!.id, "yes");
  await done;
  assert.equal(fs.existsSync(path.join(repo, "NOTE.md")), true);
  assert.equal((runner.items(thread.id).find((i) => i.id === approval!.id) as { answer?: string }).answer, "yes");
  assert.equal(runner.status(thread.id), "idle");
});

test("denying an approval leaves the tree untouched and tells the model", async () => {
  const h = harness([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "understood" },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "chat" });
  const done = runner.send(thread.id, "write NOTE.md");
  const approval = await waitFor(() => runner.items(thread.id).find((i) => i.kind === "approval"));
  runner.answer(thread.id, approval!.id, "no");
  await done;
  assert.equal(fs.existsSync(path.join(repo, "NOTE.md")), false);
  const tool = runner.items(thread.id).find((i) => i.kind === "tool") as { ok: boolean; output?: string };
  assert.equal(tool.ok, false);
  assert.match(tool.output ?? "", /not approved/);
});

test("stop cancels a waiting approval and returns the thread to idle", async () => {
  const h = harness([
    { tool_calls: [{ name: "write_file", arguments: { path: "x.txt", content: "x" } }] },
    { content: "unreachable" },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "chat" });
  const done = runner.send(thread.id, "go");
  await waitFor(() => runner.items(thread.id).find((i) => i.kind === "approval"));
  runner.stop(thread.id);
  await done;
  assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);
  assert.equal(runner.status(thread.id), "idle");
  await assert.rejects(runner.send("nope", "x"), /unknown thread/);
});

test("two threads in the same project run concurrently and independently", async () => {
  const h = harness();
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  // A backend that takes 300ms per turn: serial execution would need ≥600ms for two threads.
  const slow: Backend = {
    id: "mock",
    listModels: async () => [],
    dispose: async () => {},
    async runTurn(_text: string, _o: TurnOptions, sink: TurnSink): Promise<TurnResult> {
      await new Promise((r) => setTimeout(r, 300));
      sink.assistant("finished");
      return { status: "completed" };
    },
  };
  const runner = new ThreadRunner({ ...h, backends: { mock: slow } });
  const a = await runner.createThread(project.id, { mode: "full-access" });
  const b = await runner.createThread(project.id, { mode: "full-access" });
  const started = Date.now();
  await Promise.all([runner.send(a.id, "task a"), runner.send(b.id, "task b")]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 550, `expected parallel execution, took ${elapsed}ms`);
  assert.equal(runner.status(a.id), "idle");
  assert.equal(runner.status(b.id), "idle");
  const order = h.events.filter((e) => e.type === "status").map((e) => e.threadId);
  assert.ok(order.indexOf(b.id) < order.lastIndexOf(a.id), "events interleave across threads");
  await assert.rejects(async () => {
    const p = runner.send(a.id, "again");
    await runner.send(a.id, "while busy");
    await p;
  }, /still working/);
});

test("worktree threads work on an isolated branch; deleting removes the worktree", async () => {
  const h = harness([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "done" },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { worktree: true, mode: "agent" });
  assert.ok(thread.worktree);
  assert.equal(thread.worktree!.branch, `modex/${thread.id}`);
  assert.ok(thread.cwd.startsWith(path.join(h.home, "worktrees")));
  await runner.send(thread.id, "note");
  assert.equal(fs.existsSync(path.join(thread.cwd, "NOTE.md")), true);
  assert.equal(fs.existsSync(path.join(repo, "NOTE.md")), false, "main checkout untouched");
  await runner.deleteThread(thread.id, true);
  assert.equal(fs.existsSync(thread.cwd), false);
  assert.equal(h.store.thread(thread.id), undefined);
  assert.equal(new Store(h.home).items(thread.id).length, 0);
});

test("reasoning with no text still yields a finished Thinking row; completion-only text is kept", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const quiet: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    sink.thinkingDelta("r-empty", ""); sink.thinkingDone("r-empty");
    sink.thinkingDone("r-late", "Decided to answer directly.");
    sink.assistant("hi"); return { status: "completed" };
  } };
  const runner = new ThreadRunner({ ...h, backends: { mock: quiet } });
  const thread = await runner.createThread(project.id);
  await runner.send(thread.id, "hello");
  const kinds = runner.items(thread.id).map((i) => `${i.kind}${i.kind === "thinking" ? `:${i.status}:${i.text}` : ""}`);
  assert.deepEqual(kinds, ["user", "thinking:done:", "thinking:done:Decided to answer directly.", "assistant"]);
});

test("worktree threads use the project's scripts/worktree.sh when it exists; deletion goes through it too", async () => {
  const h = harness([{ content: "ok" }]);
  const repo = gitRepo();
  // A minimal stand-in for the convention script: `new <name>` prints the path, `remove <name>` logs the call.
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "scripts", "worktree.sh"), `#!/usr/bin/env bash
set -e
root="$(git rev-parse --show-toplevel)"
case "$1" in
  new) mkdir -p "$root/.worktrees"; git worktree add -q -b "$2" "$root/.worktrees/$2" HEAD; echo "note: installed deps" >&2; echo "$root/.worktrees/$2";;
  remove) echo "remove $2" >> "$root/.wt-calls"; git worktree remove "$root/.worktrees/$2"; git branch -q -D "$2";;
esac
`);
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { worktree: true });
  assert.equal(thread.worktree?.manager, "project-script");
  assert.equal(thread.worktree?.branch, `modex-${thread.id}`);
  assert.equal(thread.cwd, fs.realpathSync(path.join(repo, ".worktrees", `modex-${thread.id}`)), "cwd is the path the script printed, not ~/.modex");
  assert.equal(fs.existsSync(path.join(thread.cwd, "README.md")), true);
  await runner.send(thread.id, "hello");
  await runner.deleteThread(thread.id, true);
  assert.equal(fs.readFileSync(path.join(repo, ".wt-calls"), "utf8").trim(), `remove modex-${thread.id}`);
  assert.equal(fs.existsSync(thread.cwd), false);
});

test("worktree threads fall back to ~/.modex/worktrees when the project has no script", async () => {
  const h = harness([{ content: "ok" }]);
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { worktree: true });
  assert.equal(thread.worktree?.manager, "modex");
  assert.ok(thread.cwd.startsWith(path.join(h.home, "worktrees")));
  await runner.deleteThread(thread.id, true);
  assert.equal(fs.existsSync(thread.cwd), false);
});

test("a failing project script surfaces as an error, not a half-created thread", async () => {
  const h = harness();
  const repo = gitRepo();
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "scripts", "worktree.sh"), "#!/usr/bin/env bash\necho 'boom: refusing' >&2; exit 3\n");
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  await assert.rejects(runner.createThread(project.id, { worktree: true }), /scripts\/worktree.sh new modex-\w+ failed: boom: refusing/);
  assert.equal(h.store.snapshot().threads.length, 0);
});

test("a backend failure becomes an error notice, not a crash", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const failing: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn: async () => ({ status: "failed", error: "codex: not logged in" }) };
  const runner = new ThreadRunner({ ...h, backends: { mock: failing } });
  const thread = await runner.createThread(project.id);
  await runner.send(thread.id, "hi");
  assert.equal(runner.status(thread.id), "error");
  const notice = runner.items(thread.id).find((i) => i.kind === "notice") as { text: string };
  assert.match(notice.text, /not logged in/);
});

test("switching backend resets the resume handle and model; plan/effort persist", async () => {
  const h = harness([{ content: "ok" }]);
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "agent" });
  assert.equal(thread.backend, "mock");
  await runner.send(thread.id, "hello");
  assert.ok(h.store.thread(thread.id)?.sessionHandle);
  runner.updateThread(thread.id, { plan: true, effort: "high" });
  assert.equal(h.store.thread(thread.id)?.plan, true);
  const switched = runner.updateThread(thread.id, { backend: "codex" });
  assert.equal(switched.backend, "codex");
  assert.equal(switched.sessionHandle, undefined);
  assert.equal(switched.effort, undefined);
  assert.equal(switched.plan, true);
});

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("Auto threads: a route item lands before the turn, the pick is applied, and a hand-picked model teaches the fit", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const seen: TurnOptions[] = [];
  const two: Backend = {
    id: "mock",
    listModels: async () => [{ id: "mini", label: "Mini", description: "fastest", efforts: ["low", "high"] }, { id: "big", label: "Big", efforts: ["low", "high"] }],
    dispose: async () => {},
    async runTurn(_t, o, sink) { seen.push(o); sink.session("s1"); sink.assistant("ok"); return { status: "completed" }; },
  };
  const { Router } = await import("../src/main/engine/routing/router.js");
  const router = new Router({ home: h.home, policy: () => h.store.settings.routing, listModels: async () => ({ models: await two.listModels() }), transport: null });
  const runner = new ThreadRunner({ ...h, backends: { mock: two }, router });
  const thread = await runner.createThread(project.id, { mode: "agent", auto: true });
  assert.equal(thread.auto, true);
  await runner.send(thread.id, "quick: rename x to y in one file");
  const items = runner.items(thread.id);
  assert.deepEqual(items.map((i) => i.kind), ["user", "route", "assistant"]);
  const route = items[1] as Extract<ThreadItem, { kind: "route" }>;
  assert.deepEqual([route.source, route.model, route.task, route.fast], ["heuristic", "mini", "small_edit", false], "tier-0 pick, offline judge");
  assert.equal(seen[0]!.model, "mini", "the backend ran on the routed model");
  assert.equal(seen[0]!.effort, "low");
  assert.equal(h.store.thread(thread.id)?.model, "mini", "the thread now shows the pick");
  assert.ok(h.events.some((e) => e.type === "thread" && (e as { thread: Thread }).thread.model === "mini"), "renderer was told");
  assert.equal(new Store(h.home).items(thread.id).length, 3, "the receipt persists");
  const status = await router.status();
  assert.deepEqual([status.live, status.fit.routes], [false, 1]);
  // Picking a bigger model by hand after an Auto pick records an upward override and says so.
  runner.updateThread(thread.id, { model: "big" });
  const notice = await waitFor(() => runner.items(thread.id).find((i) => i.kind === "notice"));
  assert.match((notice as { text: string }).text, /for small edit you chose tier 2 over Auto's tier 0/);
  assert.equal((await router.status()).fit.tasks.small_edit!.overridesUp, 1);
  // Auto off: no route item, the thread runs on whatever it has.
  runner.updateThread(thread.id, { auto: false });
  await runner.send(thread.id, "again");
  assert.deepEqual(runner.items(thread.id).slice(-2).map((i) => i.kind), ["user", "assistant"]);
  assert.equal(seen[1]!.model, "big");
});

test("Auto threads: a routing failure is a warning, not a lost turn", async () => {
  const h = harness([{ content: "fine" }]);
  const project = h.store.addProject(gitRepo());
  const { Router } = await import("../src/main/engine/routing/router.js");
  const router = new Router({ home: h.home, policy: () => h.store.settings.routing, listModels: async () => { throw new Error("no models"); }, transport: null });
  const runner = new ThreadRunner({ ...h, router });
  const thread = await runner.createThread(project.id, { auto: true });
  await runner.send(thread.id, "hello");
  const kinds = runner.items(thread.id).map((i) => i.kind);
  assert.deepEqual(kinds, ["user", "notice", "assistant"]);
  assert.match((runner.items(thread.id)[1] as { text: string }).text, /Auto routing failed \(no models\)/);
  assert.equal(runner.status(thread.id), "idle");
});
