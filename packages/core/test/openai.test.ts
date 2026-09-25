import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider, readStream } from "../src/providers/openai.js";

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  // Split at awkward byte offsets to prove buffering works.
  const parts = [text.slice(0, 17), text.slice(17, 61), text.slice(61)];
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
}

test("readStream: assembles text deltas and tool calls split across chunks", async () => {
  const deltas: string[] = [];
  const result = await readStream(sse([
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "shell", arguments: '{"comm' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "list_dir", arguments: "{}" } }] } }] },
    { choices: [], usage: { total_tokens: 42 } },
    "[DONE]",
  ]), (t) => deltas.push(t));
  assert.equal(result.content, "Hello");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.deepEqual(result.toolCalls, [{ id: "call_a", name: "shell", arguments: '{"command":"ls"}' }, { id: "call_b", name: "list_dir", arguments: "{}" }]);
  assert.equal(result.usage?.total_tokens, 42);
});

test("OpenAIProvider: streams when onDelta is given, plain JSON otherwise", async () => {
  const seen: { stream: unknown }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { stream?: boolean };
    seen.push({ stream: body.stream });
    if (body.stream) return new Response(sse([{ choices: [{ delta: { content: "streamed" } }] }, "[DONE]"]), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "plain" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new OpenAIProvider("http://x/v1", "k", fetchImpl);
  const deltas: string[] = [];
  const a = await p.complete([{ role: "user", content: "hi" }], [], { model: "m", onDelta: (t) => deltas.push(t) });
  const b = await p.complete([{ role: "user", content: "hi" }], [], { model: "m" });
  assert.equal(a.content, "streamed");
  assert.deepEqual(deltas, ["streamed"]);
  assert.equal(b.content, "plain");
  assert.deepEqual(seen.map((s) => s.stream), [true, undefined]);
});
