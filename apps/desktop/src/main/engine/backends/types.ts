import type { ApprovalAnswer, BackendId, Mode, ModelInfo } from "../../../shared/types.js";

export type { ModelInfo };

export interface ToolStart {
  id: string;
  /** Backend tool name, e.g. "Bash", "commandExecution", "Edit". */
  name: string;
  /** One-line human title, e.g. "$ npm test" or "edit src/app.ts". */
  title: string;
  args: Record<string, unknown>;
}

export interface ToolUpdate {
  output?: string;
  ok?: boolean;
  status?: "running" | "done";
  durationMs?: number;
}

export interface ApprovalRequest {
  question: string;
  detail?: string;
  /** Whether the backend can honour an "always" answer for this request. */
  canAlways: boolean;
}

/** Callbacks a backend uses to report one turn to the ThreadRunner. */
export interface TurnSink {
  delta(text: string): void;
  assistant(text: string): void;
  toolStart(tool: ToolStart): void;
  toolUpdate(id: string, patch: ToolUpdate): void;
  approval(req: ApprovalRequest): Promise<ApprovalAnswer>;
  notice(level: "info" | "warn" | "error", text: string): void;
  /** Reasoning text as it streams; the first delta for an id opens a Thinking item. */
  thinkingDelta(id: string, delta: string): void;
  /** Closes a Thinking item, optionally replacing its text with the final version. */
  thinkingDone(id: string, text?: string): void;
  /** Called once the backend has a resumable handle (Claude session id, Codex thread id). */
  session(handle: string): void;
}

export interface TurnOptions {
  cwd: string;
  mode: Mode;
  /** Plan mode: think and propose, never edit. */
  plan: boolean;
  model: string;
  /** Reasoning effort (Codex `effort`, Claude `--effort`). */
  effort?: string;
  /** Fast mode for this turn (Codex "fast" service tier, Claude fastMode setting). */
  fast?: boolean;
  /** Resumable handle from a previous turn on this thread. */
  resume?: string;
  /** Extra directories the agent may write to (worktree threads pass the project root). */
  addDirs?: string[];
}

export interface TurnResult {
  status: "completed" | "interrupted" | "failed";
  error?: string;
}

export interface Backend {
  readonly id: BackendId;
  /** Runs one user turn to completion. `signal` aborts/interrupts the turn. */
  runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult>;
  /** Current model catalogue for this backend. */
  listModels(): Promise<ModelInfo[]>;
  dispose(): Promise<void>;
}

/** Splits a byte stream into complete lines; keeps the trailing partial line. */
export class LineBuffer {
  private buf = "";
  push(chunk: Buffer | string, onLine: (line: string) => void): void {
    this.buf += chunk.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  }
  flush(onLine: (line: string) => void): void {
    if (this.buf.trim()) onLine(this.buf);
    this.buf = "";
  }
}

export function shortJson(v: unknown, max = 2000): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}
