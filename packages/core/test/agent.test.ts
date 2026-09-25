import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Agent, type AgentEvent } from "../src/agent.js";
import { MockProvider } from "../src/providers/mock.js";
import { Session } from "../src/session.js";
import { recordedUI, testConfig, tmpdir } from "./helpers.js";

test("agent loop: tool calls run, results feed back, final answer returned, events emitted", async () => {
  const cwd = tmpdir();
  const home = tmpdir();
  fs.writeFileSync(path.join(cwd, "hello.txt"), "hi\n");
  const provider = new MockProvider([
    { content: "Looking around.", tool_calls: [{ name: "list_dir", arguments: {} }, { name: "read_file", arguments: { path: "hello.txt" } }] },
    { tool_calls: [{ name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Add File: out.md\n+# made by modex\n*** End Patch" } }] },
    { tool_calls: [{ name: "shell", arguments: { command: "cat out.md" } }] },
    { content: "Done: created out.md." },
  ]);
  const ui = recordedUI();
  const events: AgentEvent[] = [];
  const cfg = testConfig(home, { approval_policy: "never", sandbox_mode: "workspace-write" });
  const session = Session.create(home, cwd, cfg.model);
  const agent = new Agent({ cfg, provider, ui, cwd, session, systemPrompt: "sys", onEvent: (e) => events.push(e) });
  const result = await agent.run("make a file");
  assert.equal(result.finalMessage, "Done: created out.md.");
  assert.equal(result.toolCalls, 4);
  assert.equal(fs.readFileSync(path.join(cwd, "out.md"), "utf8"), "# made by modex\n");
  // the shell result made it back into the transcript
  const toolMsgs = agent.messages.filter((m) => m.role === "tool");
  assert.ok(toolMsgs.some((m) => m.name === "shell" && m.content.includes("# made by modex")));
  assert.ok(toolMsgs.some((m) => m.name === "read_file" && m.content.includes("1| hi")));
  // the mock provider saw the tool results on its 3rd call
  assert.ok(provider.calls[2]!.some((m) => m.role === "tool" && m.content.startsWith("Done!")));
  // structured events
  assert.deepEqual(events.filter((e) => e.type === "tool_start").map((e) => (e as { title: string }).title), ["list .", "read hello.txt", "edit out.md", "$ cat out.md"]);
  assert.ok(events.every((e) => e.type !== "tool_end" || e.ok));
  assert.equal(events.at(-1)?.type, "turn_end");
  // streamed deltas reassemble into each assistant message
  const streamed = events.filter((e) => e.type === "assistant_delta").map((e) => (e as { text: string }).text).join("");
  assert.equal(streamed, "Looking around.Done: created out.md.");
  // persisted transcript (everything but the regenerated system prompt) can be resumed
  const loaded = Session.load(home, session.meta.id);
  assert.ok(loaded);
  assert.deepEqual(loaded.messages, agent.messages.slice(1));
  const resumed = new Agent({ cfg, provider, ui, cwd, systemPrompt: "sys2", history: loaded.messages });
  assert.equal(resumed.messages[0]?.content, "sys2");
  assert.equal(resumed.messages.length, agent.messages.length);
});

test("agent loop: approvals gate writes under read-only sandbox; denial is reported to the model", async () => {
  const cwd = tmpdir();
  const provider = new MockProvider([
    { tool_calls: [{ name: "write_file", arguments: { path: "a.txt", content: "A" } }] },
    { tool_calls: [{ name: "write_file", arguments: { path: "b.txt", content: "B" } }] },
    { content: "ok" },
  ]);
  const ui = recordedUI(["no", "yes"]);
  const cfg = testConfig(tmpdir(), { approval_policy: "on-request", sandbox_mode: "read-only" });
  const agent = new Agent({ cfg, provider, ui, cwd, systemPrompt: "sys" });
  await agent.run("write two files");
  assert.equal(ui.confirms.length, 2);
  assert.equal(fs.existsSync(path.join(cwd, "a.txt")), false);
  assert.equal(fs.readFileSync(path.join(cwd, "b.txt"), "utf8"), "B");
  assert.ok(agent.messages.some((m) => m.role === "tool" && m.content.includes("not approved")));
});

test("agent loop: bad tool arguments and unknown tools return errors instead of throwing; max_turns stops", async () => {
  const cwd = tmpdir();
  const provider = new MockProvider([
    { tool_calls: [{ name: "read_file", arguments: "{not json" }, { name: "teleport", arguments: {} }] },
    { tool_calls: [{ name: "list_dir", arguments: {} }] },
    { tool_calls: [{ name: "list_dir", arguments: {} }] },
  ]);
  const ui = recordedUI();
  const cfg = testConfig(tmpdir(), { approval_policy: "never", max_turns: 2 });
  const agent = new Agent({ cfg, provider, ui, cwd, systemPrompt: "sys" });
  const result = await agent.run("go");
  assert.match(result.finalMessage, /max_turns/);
  const tools = agent.messages.filter((m) => m.role === "tool");
  assert.match(tools[0]!.content, /could not parse arguments/);
  assert.match(tools[1]!.content, /unknown tool teleport/);
});

test("agent loop: abort signal cancels remaining tool calls", async () => {
  const cwd = tmpdir();
  const ac = new AbortController();
  const provider = new MockProvider([
    { tool_calls: [{ name: "shell", arguments: { command: "echo first" } }, { name: "shell", arguments: { command: "echo second" } }] },
    { content: "unreachable" },
  ]);
  const ui = recordedUI();
  const cfg = testConfig(tmpdir(), { approval_policy: "never" });
  const agent = new Agent({ cfg, provider, ui, cwd, systemPrompt: "sys", signal: ac.signal, onEvent: (e) => { if (e.type === "tool_end") ac.abort(); } });
  const result = await agent.run("go");
  assert.equal(result.finalMessage, "(cancelled)");
  const tools = agent.messages.filter((m) => m.role === "tool");
  assert.equal(tools.length, 2);
  assert.match(tools[1]!.content, /cancelled/);
});
