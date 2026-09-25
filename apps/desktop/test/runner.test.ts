import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner, policyForMode } from "../src/main/engine/runner.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { MockProvider, type Provider } from "@modex/core";
import { gitRepo, scripted, tmpdir } from "./helpers.js";

function harness() {
  const home = tmpdir("modex-home-");
  const store = new Store(home);
  const events: ThreadEvent[] = [];
  return { home, store, events, emit: (e: ThreadEvent) => events.push(e) };
}

const PATCH = "*** Begin Patch\n*** Add File: NOTE.md\n+hello from modex\n*** End Patch";

test("policyForMode mirrors Codex modes", () => {
  assert.deepEqual(policyForMode("chat"), { approval_policy: "untrusted", sandbox_mode: "read-only" });
  assert.deepEqual(policyForMode("agent"), { approval_policy: "on-request", sandbox_mode: "workspace-write" });
  assert.deepEqual(policyForMode("full-access"), { approval_policy: "never", sandbox_mode: "danger-full-access" });
});

test("agent mode: a prompt runs tools, edits the project, emits items, persists, and sets the title", async () => {
  const h = harness();
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner({ ...h, providerFactory: scripted([
    { content: "Looking.", tool_calls: [{ name: "shell", arguments: { command: "ls" } }] },
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "Added NOTE.md." },
  ]) });
  const thread = await runner.createThread(project.id, { mode: "agent" });
  assert.equal(thread.cwd, repo);
  await runner.send(thread.id, "add a note file please");
  assert.equal(fs.readFileSync(path.join(repo, "NOTE.md"), "utf8"), "hello from modex\n");
  const items = runner.items(thread.id);
  assert.deepEqual(items.map((i) => i.kind), ["user", "assistant", "tool", "tool", "assistant"]);
  const tools = items.filter((i): i is Extract<ThreadItem, { kind: "tool" }> => i.kind === "tool");
  assert.equal(tools[0]!.title, "$ ls");
  assert.equal(tools[0]!.status, "done");
  assert.ok(tools[0]!.output?.includes("README.md"));
  assert.equal(tools[1]!.title, "edit NOTE.md");
  assert.equal(tools[1]!.ok, true);
  assert.equal(runner.status(thread.id), "idle");
  assert.equal(h.store.thread(thread.id)?.title, "add a note file please");
  assert.ok(h.store.thread(thread.id)?.sessionId);
  // statuses went running → idle; items were persisted for restart
  const statuses = h.events.filter((e) => e.type === "status").map((e) => (e as { status: string }).status);
  assert.deepEqual(statuses, ["running", "idle"]);
  assert.equal(new Store(h.home).items(thread.id).length, items.length);
});

test("chat mode: edits pause on an approval card; answering resumes the turn", async () => {
  const h = harness();
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner({ ...h, providerFactory: scripted([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "ok" },
  ]) });
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
  const h = harness();
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner({ ...h, providerFactory: scripted([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "understood" },
  ]) });
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
  const h = harness();
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner({ ...h, providerFactory: scripted([
    { tool_calls: [{ name: "write_file", arguments: { path: "x.txt", content: "x" } }] },
    { content: "unreachable" },
  ]) });
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
  // A provider that takes 300ms per completion: serial execution would need ≥1200ms for two threads × two calls.
  const slow = (): Provider => {
    const inner = new MockProvider([{ tool_calls: [{ name: "list_dir", arguments: {} }] }, { content: "finished" }]);
    return { name: "slow", complete: async (m, t) => { await new Promise((r) => setTimeout(r, 300)); return inner.complete(m, t); } };
  };
  const runner = new ThreadRunner({ ...h, providerFactory: slow });
  const a = await runner.createThread(project.id, { mode: "full-access" });
  const b = await runner.createThread(project.id, { mode: "full-access" });
  const started = Date.now();
  await Promise.all([runner.send(a.id, "task a"), runner.send(b.id, "task b")]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `expected parallel execution, took ${elapsed}ms`);
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
  const h = harness();
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner({ ...h, providerFactory: scripted([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "done" },
  ]) });
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

test("a provider error becomes an error notice, not a crash", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner({ ...h, providerFactory: () => { throw new Error("No API key: set OPENAI_API_KEY"); } });
  const thread = await runner.createThread(project.id);
  await runner.send(thread.id, "hi");
  assert.equal(runner.status(thread.id), "error");
  const notice = runner.items(thread.id).find((i) => i.kind === "notice") as { text: string };
  assert.match(notice.text, /OPENAI_API_KEY/);
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
