import fs from "node:fs";
import type { ChatMessage, CompletionOptions, CompletionResult, Provider, ToolSpec } from "../types.js";

export interface MockStep {
  content?: string;
  tool_calls?: { name: string; arguments: Record<string, unknown> | string }[];
}

/**
 * Scripted provider for tests and offline demos. Each `complete()` call consumes the next
 * step; once the script is exhausted it answers with a fixed final message.
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly calls: ChatMessage[][] = [];
  private cursor = 0;
  /** Delay between streamed words when a caller asks for deltas (0 in tests). */
  streamDelayMs = 0;
  constructor(private readonly steps: MockStep[]) {}

  static fromFile(file: string): MockProvider {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as MockStep[] | { steps: MockStep[] };
    return new MockProvider(Array.isArray(raw) ? raw : raw.steps);
  }

  async complete(messages: ChatMessage[], _tools: ToolSpec[], opts?: CompletionOptions): Promise<CompletionResult> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const step = this.steps[this.cursor++];
    if (!step) return { content: "(mock script exhausted)", toolCalls: [] };
    if (opts?.onDelta && step.content) {
      // Stream word by word with a small delay so the UI shows text arriving.
      for (const word of step.content.split(/(?<=\s)/)) {
        opts.onDelta(word);
        await new Promise((r) => setTimeout(r, this.streamDelayMs));
      }
    }
    return {
      content: step.content ?? "",
      toolCalls: (step.tool_calls ?? []).map((c, i) => ({
        id: `mock_${this.cursor}_${i}`,
        name: c.name,
        arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
      })),
    };
  }
}
