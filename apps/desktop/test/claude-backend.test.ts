import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeBackend, toolTitle } from "../src/main/engine/backends/claude.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";

test("ClaudeBackend.args maps modes and plan onto claude -p flags", () => {
  const base = { cwd: "/w", model: "sonnet", plan: false } as const;
  assert.deepEqual(ClaudeBackend.args({ ...base, mode: "agent" }).slice(-4), ["--permission-mode", "acceptEdits", "--model", "sonnet"]);
  assert.ok(ClaudeBackend.args({ ...base, mode: "chat" }).join(" ").includes("--permission-mode manual --disallowedTools Edit Write NotebookEdit"));
  assert.ok(ClaudeBackend.args({ ...base, mode: "full-access" }).includes("bypassPermissions"));
  assert.ok(ClaudeBackend.args({ ...base, mode: "agent", plan: true }).join(" ").includes("--permission-mode plan"));
  assert.ok(ClaudeBackend.args({ ...base, mode: "agent", resume: "abc" }).join(" ").includes("--resume abc"));
  const a = ClaudeBackend.args({ ...base, mode: "agent" });
  for (const f of ["-p", "--input-format", "stream-json", "--output-format", "--include-partial-messages", "--permission-prompt-tool", "stdio"]) assert.ok(a.includes(f), f);
  assert.equal(toolTitle("Bash", { command: "npm test" }), "$ npm test");
  assert.equal(toolTitle("Edit", { file_path: "src/a.ts" }), "edit src/a.ts");
});

test("ClaudeBackend: streams deltas, tools, answers a permission request, resumes by session id", async () => {
  const proc = new FakeProcess();
  const { spawn, calls } = fakeSpawn(proc);
  const backend = new ClaudeBackend("claude", spawn);
  const { sink, events } = collectSink(["always"]);
  const ac = new AbortController();
  const run = backend.runTurn("write probe.txt", { cwd: "/repo", mode: "agent", plan: false, model: "sonnet" }, sink, ac.signal);

  const first = await proc.waitFor((l) => l.includes('"type":"user"'));
  assert.match(first, /write probe.txt/);
  assert.equal(calls[0]!.cwd, "/repo");

  proc.emitLine({ type: "system", subtype: "init", session_id: "sess-1" });
  proc.emitLine({ type: "stream_event", event: { type: "message_start", message: {} } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan: " } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "write it." } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Sure, " } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "writing." } } });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Plan: write it." }, { type: "text", text: "Sure, writing." }, { type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/repo/probe.txt", content: "hi" } }] } });
  proc.emitLine({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/repo/probe.txt", content: "hi" }, permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } });
  const resp = JSON.parse(await proc.waitFor((l) => l.includes("control_response"))) as { response: { request_id: string; response: { behavior: string; updatedPermissions?: unknown[] } } };
  assert.equal(resp.response.request_id, "r1");
  assert.equal(resp.response.response.behavior, "allow");
  assert.equal(resp.response.response.updatedPermissions?.length, 1, "'always' forwards the CLI's permission suggestion");
  proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "File created successfully", is_error: false }] } });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", result: "Done." });
  proc.close(0);

  const r = await run;
  assert.equal(r.status, "completed");
  assert.deepEqual(events, [
    "session:sess-1",
    "think:think-1:",
    "think:think-1:Plan: ",
    "think:think-1:write it.",
    "think_done:think-1:",
    "delta:Sure, ",
    "delta:writing.",
    "assistant:Sure, writing.",
    "tool_start:tu1:write /repo/probe.txt",
    "approval:Allow Write: write /repo/probe.txt?",
    "tool_update:tu1:done:true:File created successfully",
    "assistant:Done.",
    "session:sess-1",
  ]);
});

test("ClaudeBackend: denial and failure paths", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const { sink, events } = collectSink(["no"]);
  const run = backend.runTurn("rm it", { cwd: "/repo", mode: "chat", plan: false, model: "" }, sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf x" } } });
  const resp = JSON.parse(await proc.waitFor((l) => l.includes("control_response"))) as { response: { response: { behavior: string } } };
  assert.equal(resp.response.response.behavior, "deny");
  proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
  proc.close(1);
  const r = await run;
  assert.equal(r.status, "failed");
  assert.equal(r.error, "boom");
  assert.ok(events.includes("approval:Allow Bash: $ rm -rf x?"));
});

test("ClaudeBackend: abort kills the process and reports interrupted", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const ac = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, collectSink().sink, ac.signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  ac.abort();
  const r = await run;
  assert.equal(r.status, "interrupted");
  assert.equal(proc.killed, true);
});

test("ClaudeBackend.args passes reasoning effort and fast mode; models advertise the effort ladder", () => {
  const base = { cwd: "/w", model: "haiku", plan: false, mode: "agent" as const };
  const plain = ClaudeBackend.args(base).join(" ");
  assert.ok(!plain.includes("--effort") && !plain.includes("--settings"));
  const tuned = ClaudeBackend.args({ ...base, effort: "xhigh", fast: true });
  assert.ok(tuned.join(" ").includes("--effort xhigh"));
  assert.equal(tuned[tuned.indexOf("--settings") + 1], '{"fastMode":true}');
  assert.deepEqual(ClaudeBackend.MODELS[0]!.efforts, ["low", "medium", "high", "xhigh", "max"]);
});
