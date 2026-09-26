import { spawn, type ChildProcess } from "node:child_process";
import type { Backend, ModelInfo, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { LineBuffer } from "./types.js";

/**
 * Drives the Codex CLI through `codex app-server`, the JSON-RPC-over-stdio protocol the
 * official Codex App uses. One server process is shared by all Codex threads; each Modex
 * thread maps to a Codex thread id, which is the resume handle. Approvals arrive as server
 * requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`).
 */
export class CodexBackend implements Backend {
  readonly id = "codex" as const;
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly subscribers = new Set<(msg: RpcMessage) => void>();
  private readonly loaded = new Set<string>();

  constructor(private readonly bin = process.env.MODEX_CODEX_BIN ?? "codex", private readonly spawnImpl = spawn) {}

  private ensure(): Promise<void> {
    if (this.ready && this.child && this.child.exitCode === null) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(this.bin, ["app-server", "-c", 'model_reasoning_summary="detailed"'], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      } catch (err) {
        return reject(new Error(`could not start ${this.bin} app-server: ${(err as Error).message}`));
      }
      this.child = child;
      this.loaded.clear();
      const lines = new LineBuffer();
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.stdout?.on("data", (d: Buffer) => lines.push(d, (line) => this.dispatch(line)));
      child.on("error", (err) => reject(new Error(`${this.bin}: ${err.message}. Is the Codex CLI installed and on PATH?`)));
      child.on("close", (code) => {
        for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited (${code}) ${stderr.trim().split("\n").slice(-2).join(" ")}`));
        this.pending.clear();
        this.child = null;
        this.ready = null;
      });
      this.request("initialize", { clientInfo: { name: "modex", title: "Modex", version: process.env.MODEX_VERSION ?? "0.0.1" }, capabilities: {} })
        .then(() => {
          this.notify("initialized", {});
          resolve();
        })
        .catch(reject);
    });
    return this.ready;
  }

  private dispatch(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (typeof msg.id === "number" && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "codex error"));
        else p.resolve(msg.result);
      }
      return;
    }
    for (const s of this.subscribers) s(msg);
  }

  private send(o: unknown): void {
    this.child?.stdin?.write(JSON.stringify(o) + "\n");
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private respond(id: unknown, result: unknown): void {
    this.send({ id, result });
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.ensure();
    const res = await this.request<{ data: CodexModel[] }>("model/list", {});
    return res.data
      .filter((m) => !m.hidden)
      .map((m) => ({
        id: m.id, label: m.displayName || m.id, description: m.description, isDefault: m.isDefault,
        efforts: m.supportedReasoningEfforts?.map((e) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort,
        serviceTiers: m.serviceTiers?.map((t) => t.id), defaultServiceTier: m.defaultServiceTier ?? undefined,
      }));
  }

  async dispose(): Promise<void> {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  /** Mode → Codex approval policy + sandbox policy. Exported for tests. */
  static policy(opts: TurnOptions): { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> } {
    const roots = opts.addDirs ?? [];
    if (opts.plan || opts.mode === "chat") return { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    if (opts.mode === "agent") return { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
    return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  }

  async runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    try {
      await this.ensure();
    } catch (err) {
      return { status: "failed", error: (err as Error).message };
    }
    const pol = CodexBackend.policy(opts);
    let threadId = opts.resume;
    try {
      if (threadId && !this.loaded.has(threadId)) {
        const r = await this.request<{ thread: { id: string } }>("thread/resume", { threadId, cwd: opts.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox, model: opts.model || null, config: THREAD_CONFIG });
        threadId = r.thread.id;
      } else if (!threadId) {
        const r = await this.request<{ thread: { id: string } }>("thread/start", { cwd: opts.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox, model: opts.model || null, config: THREAD_CONFIG });
        threadId = r.thread.id;
      }
    } catch (err) {
      return { status: "failed", error: (err as Error).message };
    }
    this.loaded.add(threadId);
    sink.session(threadId);

    const tid = threadId;
    const input = opts.plan
      ? `${PLAN_PREFIX}\n\n${text}`
      : text;
    const tools = new Map<string, { started: number; output: string }>();
    const reasoning = new Set<string>();
    let turnId: string | null = null;
    const streaming = new Map<string, string>();

    return new Promise<TurnResult>((resolve) => {
      let done = false;
      const finish = (r: TurnResult) => {
        if (done) return;
        done = true;
        this.subscribers.delete(onMsg);
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => {
        if (turnId) this.notify("turn/interrupt", { threadId: tid, turnId });
        this.request("turn/interrupt", { threadId: tid, turnId }).catch(() => {});
        setTimeout(() => finish({ status: "interrupted" }), 1500);
      };
      const onMsg = (msg: RpcMessage) => {
        const p = (msg.params ?? {}) as Record<string, unknown>;
        if (p.threadId && p.threadId !== tid) return;
        // Server → client requests (approvals).
        if (msg.id !== undefined && msg.method) {
          void this.handleServerRequest(msg, sink);
          return;
        }
        switch (msg.method) {
          case "item/started": {
            const item = p.item as CodexItem;
            if (item.type === "agentMessage") {
              streaming.set(item.id, "");
            } else if (item.type === "reasoning") {
              reasoning.add(item.id);
              sink.thinkingDelta(item.id, "");
            } else if (item.type === "commandExecution") {
              tools.set(item.id, { started: Date.now(), output: "" });
              sink.toolStart({ id: item.id, name: "shell", title: `$ ${stripShell(item.command ?? "")}`, args: { command: item.command, cwd: item.cwd } });
            } else if (item.type === "fileChange") {
              tools.set(item.id, { started: Date.now(), output: "" });
              const files = (item.changes ?? []).map((c) => c.path);
              sink.toolStart({ id: item.id, name: "apply_patch", title: `edit ${files.join(", ")}`, args: { patch: (item.changes ?? []).map((c) => c.diff).join("\n") } });
            } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "webSearch") {
              tools.set(item.id, { started: Date.now(), output: "" });
              const label = item.type === "webSearch" ? `search ${item.query ?? ""}` : `${item.server ? item.server + "." : ""}${item.tool ?? item.type}`;
              sink.toolStart({ id: item.id, name: item.type, title: label, args: (item.arguments as Record<string, unknown>) ?? {} });
            }
            break;
          }
          case "item/reasoning/summaryTextDelta":
          case "item/reasoning/textDelta": {
            reasoning.add(String(p.itemId));
            sink.thinkingDelta(String(p.itemId), String(p.delta ?? ""));
            break;
          }
          case "item/reasoning/summaryPartAdded": {
            if (Number(p.summaryIndex) > 0) sink.thinkingDelta(String(p.itemId), "\n\n");
            break;
          }
          case "item/agentMessage/delta": {
            const id = String(p.itemId);
            streaming.set(id, (streaming.get(id) ?? "") + String(p.delta ?? ""));
            sink.delta(String(p.delta ?? ""));
            break;
          }
          case "item/commandExecution/outputDelta": {
            const t = tools.get(String(p.itemId));
            if (t) {
              t.output += String(p.delta ?? "");
              sink.toolUpdate(String(p.itemId), { output: t.output });
            }
            break;
          }
          case "item/completed": {
            const item = p.item as CodexItem;
            if (item.type === "agentMessage") {
              if (item.phase === "commentary" && !streaming.has(item.id)) break;
              sink.assistant(item.text ?? streaming.get(item.id) ?? "");
              streaming.delete(item.id);
            } else if (tools.has(item.id)) {
              const t = tools.get(item.id)!;
              const output = item.type === "commandExecution" ? (item.aggregatedOutput ?? t.output) : item.type === "fileChange" ? (item.changes ?? []).map((c) => `${c.kind?.type ?? "update"} ${c.path}\n${c.diff}`).join("\n") : JSON.stringify(item.result ?? item.error ?? "", null, 2);
              const ok = item.type === "commandExecution" ? item.exitCode === 0 && item.status !== "declined" : item.status ? item.status === "completed" : !item.error;
              sink.toolUpdate(item.id, { output: output || undefined, ok, status: "done", durationMs: item.durationMs ?? Date.now() - t.started });
            } else if (item.type === "reasoning") {
              const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join("\n\n");
              if (reasoning.has(item.id) || text) sink.thinkingDone(item.id, text || undefined);
              reasoning.delete(item.id);
            }
            break;
          }
          case "turn/started":
            turnId = (p.turn as { id: string }).id;
            break;
          case "error": {
            const e = p.error as { message?: string } | undefined;
            if (e?.message && !p.willRetry) sink.notice("error", e.message);
            break;
          }
          case "turn/completed": {
            const turn = p.turn as { status: string; error?: { message?: string } | null };
            if (turn.status === "failed") finish({ status: "failed", error: turn.error?.message ?? "turn failed" });
            else if (turn.status === "interrupted") finish({ status: "interrupted" });
            else finish({ status: "completed" });
            break;
          }
          default:
            break;
        }
      };
      this.subscribers.add(onMsg);
      signal.addEventListener("abort", onAbort, { once: true });
      this.request<{ turn: { id: string } }>("turn/start", {
        threadId: tid,
        input: [{ type: "text", text: input, text_elements: [] }],
        cwd: opts.cwd,
        approvalPolicy: pol.approvalPolicy,
        sandboxPolicy: pol.sandboxPolicy,
        model: opts.model || null,
        effort: opts.effort ?? null,
        // "fast" is the Codex fast-mode service tier; only this turn, the thread's tier is untouched.
        serviceTierForTurn: opts.fast ? "fast" : null,
      })
        .then((r) => {
          turnId = r.turn.id;
        })
        .catch((err: Error) => finish({ status: "failed", error: err.message }));
    });
  }

  private async handleServerRequest(msg: RpcMessage, sink: TurnSink): Promise<void> {
    const p = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method === "item/commandExecution/requestApproval") {
      const cmd = stripShell(String(p.command ?? ""));
      const answer = await sink.approval({ question: `Allow command: ${cmd}?`, detail: [p.reason ? `Reason: ${String(p.reason)}` : "", `cwd: ${String(p.cwd ?? "")}`].filter(Boolean).join("\n"), canAlways: true });
      this.respond(msg.id, { decision: answer === "yes" ? "accept" : answer === "always" ? "acceptForSession" : "decline" });
    } else if (msg.method === "item/fileChange/requestApproval") {
      const answer = await sink.approval({ question: "Allow Codex to apply these file changes?", detail: [p.reason ? `Reason: ${String(p.reason)}` : "", p.grantRoot ? `grants write access to ${String(p.grantRoot)}` : ""].filter(Boolean).join("\n") || undefined, canAlways: true });
      this.respond(msg.id, { decision: answer === "yes" ? "accept" : answer === "always" ? "acceptForSession" : "decline" });
    } else if (msg.method === "item/permissions/requestApproval") {
      const answer = await sink.approval({ question: "Codex is asking for additional permissions.", detail: JSON.stringify(p, null, 2).slice(0, 1500), canAlways: false });
      this.respond(msg.id, { decision: answer === "no" ? "decline" : "accept" });
    } else {
      sink.notice("warn", `Codex asked for ${msg.method}, which Modex does not support yet; declined.`);
      this.send({ id: msg.id, error: { code: -32601, message: `unsupported by modex: ${msg.method}` } });
    }
  }
}

/** Per-thread Codex config overrides: surface reasoning summaries so the Thinking item has something to show. */
const THREAD_CONFIG = { model_reasoning_summary: "detailed" };

const PLAN_PREFIX = "PLAN MODE: Investigate the codebase read-only and reply with a concrete, numbered implementation plan (files to change, order, risks, how to verify). Do not edit files or run commands that modify anything.";

function stripShell(cmd: string): string {
  const m = /^\/bin\/(?:zsh|bash|sh) -lc '(.*)'$/s.exec(cmd) ?? /^\/bin\/(?:zsh|bash|sh) -lc "(.*)"$/s.exec(cmd);
  return m ? m[1]!.replace(/'\\''/g, "'") : cmd;
}

interface RpcMessage {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}
interface CodexModel {
  id: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
  serviceTiers?: { id: string; name?: string; description?: string }[];
  defaultServiceTier?: string | null;
}
interface CodexItem {
  type: string;
  id: string;
  text?: string;
  phase?: string | null;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: { path: string; kind?: { type: string }; diff: string }[];
  summary?: string[];
  content?: string[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
}
