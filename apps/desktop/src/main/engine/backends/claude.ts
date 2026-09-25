import { spawn, type ChildProcess } from "node:child_process";
import type { Backend, ModelInfo, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { LineBuffer, shortJson } from "./types.js";

/**
 * Drives the Claude Code CLI (`claude -p`) over its stream-json protocol:
 * newline-delimited JSON in both directions, token deltas via --include-partial-messages,
 * and permission prompts delivered as `control_request` messages that we answer on stdin.
 * No HTTP API is used — the user's `claude` login is the credential.
 */
export class ClaudeBackend implements Backend {
  readonly id = "claude" as const;
  constructor(private readonly bin = process.env.MODEX_CLAUDE_BIN ?? "claude", private readonly spawnImpl = spawn) {}

  static readonly MODELS: ModelInfo[] = [
    // Aliases always point at the newest model of each family (resolved by the CLI on every run);
    // a full model id such as "claude-fable-5-1" can be typed as well.
    { id: "fable", label: "Fable (latest)", description: "Newest Fable — currently claude-fable-5-1", isDefault: true },
    { id: "opus", label: "Opus (latest)", description: "Newest Opus — currently claude-opus-5-5" },
    { id: "sonnet", label: "Sonnet (latest)", description: "Newest Sonnet — currently claude-sonnet-5" },
    { id: "haiku", label: "Haiku (latest)", description: "Newest Haiku — currently claude-haiku-4-5" },
  ];

  async listModels(): Promise<ModelInfo[]> {
    return ClaudeBackend.MODELS;
  }

  async dispose(): Promise<void> {}

  /** CLI argv for a turn. Exported for tests. */
  static args(opts: TurnOptions): string[] {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];
    if (opts.plan) args.push("--permission-mode", "plan");
    else if (opts.mode === "chat") args.push("--permission-mode", "manual", "--disallowedTools", "Edit", "Write", "NotebookEdit");
    else if (opts.mode === "agent") args.push("--permission-mode", "acceptEdits");
    else args.push("--permission-mode", "bypassPermissions");
    if (opts.model) args.push("--model", opts.model);
    if (opts.resume) args.push("--resume", opts.resume);
    for (const d of opts.addDirs ?? []) args.push("--add-dir", d);
    return args;
  }

  runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(this.bin, ClaudeBackend.args(opts), { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
      } catch (err) {
        return resolve({ status: "failed", error: `could not start ${this.bin}: ${(err as Error).message}` });
      }
      const lines = new LineBuffer();
      const started = new Map<string, number>();
      let streaming = "";
      let finished = false;
      let stderr = "";
      const finish = (r: TurnResult) => {
        if (finished) return;
        finished = true;
        resolve(r);
      };
      const write = (o: unknown) => {
        try {
          child.stdin?.write(JSON.stringify(o) + "\n");
        } catch {
          /* closed */
        }
      };
      const onAbort = () => {
        child.kill("SIGTERM");
        finish({ status: "interrupted" });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => finish({ status: "failed", error: `${this.bin}: ${err.message}. Is Claude Code installed and on PATH?` }));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.stdout?.on("data", (d: Buffer) =>
        lines.push(d, (line) => {
          let msg: ClaudeMessage;
          try {
            msg = JSON.parse(line) as ClaudeMessage;
          } catch {
            return;
          }
          this.handle(msg, sink, { started, write, get streaming() { return streaming; }, set streaming(v: string) { streaming = v; } }).then((done) => {
            if (done) {
              child.stdin?.end();
              finish(done);
            }
          });
        }),
      );
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return finish({ status: "interrupted" });
        const err = stderr.trim().split("\n").filter((l) => !/^\s*$/.test(l)).slice(-3).join("\n");
        finish(code === 0 ? { status: "completed" } : { status: "failed", error: err || `${this.bin} exited with code ${code}` });
      });

      write({ type: "user", message: { role: "user", content: text } });
    });
  }

  private async handle(msg: ClaudeMessage, sink: TurnSink, ctx: { started: Map<string, number>; write: (o: unknown) => void; streaming: string }): Promise<TurnResult | null> {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id) sink.session(msg.session_id);
        return null;
      case "stream_event": {
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          ctx.streaming += ev.delta.text;
          sink.delta(ev.delta.text);
        }
        return null;
      }
      case "assistant": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            sink.assistant(block.text);
            ctx.streaming = "";
          } else if (block.type === "tool_use" && block.id) {
            ctx.started.set(block.id, Date.now());
            sink.toolStart({ id: block.id, name: block.name ?? "tool", title: toolTitle(block.name ?? "tool", block.input ?? {}), args: block.input ?? {} });
          }
        }
        return null;
      }
      case "user": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const content = typeof block.content === "string" ? block.content : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
            const t0 = ctx.started.get(block.tool_use_id);
            sink.toolUpdate(block.tool_use_id, { output: content, ok: !block.is_error, status: "done", durationMs: t0 ? Date.now() - t0 : undefined });
          }
        }
        return null;
      }
      case "control_request": {
        const req = msg.request;
        if (req?.subtype !== "can_use_tool") {
          ctx.write({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `unsupported control request ${req?.subtype ?? "?"}` } });
          return null;
        }
        const answer = await sink.approval({
          question: `Allow ${req.tool_name}: ${toolTitle(req.tool_name ?? "tool", req.input ?? {})}?`,
          detail: shortJson(req.input ?? {}),
          canAlways: Boolean(req.permission_suggestions?.length),
        });
        const allow = answer !== "no";
        ctx.write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: msg.request_id,
            response: allow
              ? { behavior: "allow", updatedInput: req.input ?? {}, ...(answer === "always" && req.permission_suggestions?.length ? { updatedPermissions: req.permission_suggestions } : {}) }
              : { behavior: "deny", message: "The user denied this action in Modex." },
          },
        });
        return null;
      }
      case "result": {
        if (msg.session_id) sink.session(msg.session_id);
        if (msg.is_error) return { status: "failed", error: typeof msg.result === "string" ? msg.result : msg.subtype ?? "error" };
        return { status: "completed" };
      }
      default:
        return null;
    }
  }
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
}
interface ClaudeMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  event?: { type: string; delta?: { type: string; text?: string } };
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown>; permission_suggestions?: unknown[] };
  is_error?: boolean;
  result?: unknown;
}

/** Human title for a Claude Code tool call. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Bash": return `$ ${s("command")}`;
    case "Read": return `read ${s("file_path")}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `edit ${s("file_path") || s("notebook_path")}`;
    case "Write": return `write ${s("file_path")}`;
    case "Glob": return `glob ${s("pattern")}`;
    case "Grep": return `grep ${s("pattern")}`;
    case "WebFetch": return `fetch ${s("url")}`;
    case "WebSearch": return `search ${s("query")}`;
    case "Task": return `agent: ${s("description")}`;
    default: return name;
  }
}
