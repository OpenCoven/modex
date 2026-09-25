import type { ChatMessage, CompletionOptions, CompletionResult, Provider, ToolCall, ToolSpec } from "../types.js";

interface OpenAIToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
interface OpenAIMessage { role: string; content: string | null; tool_calls?: OpenAIToolCall[]; tool_call_id?: string; name?: string }

/** Minimal OpenAI-compatible Chat Completions client (works with OpenAI, Ollama, LM Studio, vLLM, OpenRouter...). */
export class OpenAIProvider implements Provider {
  readonly name = "openai";
  constructor(private readonly baseUrl: string, private readonly apiKey: string | undefined, private readonly fetchImpl: typeof fetch = fetch) {}

  async complete(messages: ChatMessage[], tools: ToolSpec[], opts: CompletionOptions): Promise<CompletionResult> {
    const stream = Boolean(opts.onDelta);
    const body = {
      model: opts.model,
      messages: messages.map(toOpenAI),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`provider HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`provider HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        if (stream && res.body) return await readStream(res.body, opts.onDelta!);
        const json = (await res.json()) as { choices?: { message: OpenAIMessage }[]; usage?: CompletionResult["usage"]; error?: { message: string } };
        if (json.error) throw new Error(`provider error: ${json.error.message}`);
        const msg = json.choices?.[0]?.message;
        if (!msg) throw new Error("provider returned no choices");
        const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c, i) => ({
          id: c.id || `call_${i}`,
          name: c.function.name,
          arguments: c.function.arguments ?? "{}",
        }));
        return { content: msg.content ?? "", toolCalls, usage: json.usage };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        lastErr = err;
        if (attempt === 2) break;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function toOpenAI(m: ChatMessage): OpenAIMessage {
  const out: OpenAIMessage = { role: m.role, content: m.content };
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}

interface DeltaChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: CompletionResult["usage"];
  error?: { message: string };
}

/** Consumes an OpenAI-style SSE stream, emitting text deltas and assembling tool calls by index. */
export async function readStream(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<CompletionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: CompletionResult["usage"];
  const calls = new Map<number, ToolCall>();
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as DeltaChunk;
    if (chunk.error) throw new Error(`provider error: ${chunk.error.message}`);
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, nl).replace(/\r$/, ""));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) handle(buffer.trim());
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }));
  return { content, toolCalls, usage };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
