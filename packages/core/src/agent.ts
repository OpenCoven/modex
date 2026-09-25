import path from "node:path";
import type { ActionRequest, ChatMessage, ModexConfig, Provider, ToolCall } from "./types.js";
import { TOOL_SPECS } from "./tools/index.js";
import { runShell, formatShellResult } from "./tools/shell.js";
import { listDirTool, readFileTool, writeFileTool } from "./tools/files.js";
import { applyPatchToDisk, parsePatch, PatchError } from "./tools/apply_patch.js";
import { commandPrefix, decide, isInsideRoots, type PolicyContext } from "./policy.js";
import { looksLikeSandboxDenial, osSandboxAvailable, type SandboxSpec } from "./sandbox.js";
import type { UI } from "./ui.js";
import type { Session } from "./session.js";

export type AgentEvent =
  | { type: "assistant"; content: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown>; title: string }
  | { type: "tool_end"; id: string; name: string; output: string; ok: boolean; durationMs: number }
  | { type: "turn_end"; turns: number; toolCalls: number };

export interface AgentOptions {
  cfg: ModexConfig;
  /** Structured events for GUI hosts; the `ui` callbacks remain the terminal-facing surface. */
  onEvent?: (event: AgentEvent) => void;
  provider: Provider;
  ui: UI;
  cwd: string;
  session?: Session;
  systemPrompt: string;
  /** Existing transcript to continue (from resume). */
  history?: ChatMessage[];
  signal?: AbortSignal;
}

export interface TurnResult {
  finalMessage: string;
  turns: number;
  toolCalls: number;
}

/** The Modex agent loop: prompt → model → (tool calls → results)* → final answer. */
export class Agent {
  readonly messages: ChatMessage[];
  private readonly policy: PolicyContext;
  private readonly sandbox: SandboxSpec;

  constructor(private readonly o: AgentOptions) {
    // Sessions persist only user/assistant/tool messages; the system prompt is regenerated on every start.
    const history = (o.history ?? []).filter((m) => m.role !== "system");
    this.messages = [{ role: "system", content: o.systemPrompt }, ...history];
    const writableRoots = o.cfg.writable_roots.map((r) => path.resolve(o.cwd, r));
    this.policy = {
      approval: o.cfg.approval_policy,
      sandbox: o.cfg.sandbox_mode,
      workspace: o.cwd,
      writableRoots,
      osSandboxAvailable: osSandboxAvailable(),
      trustedPrefixes: [],
    };
    this.sandbox = { mode: o.cfg.sandbox_mode, writableRoots: [o.cwd, ...writableRoots], networkAccess: o.cfg.network_access };
  }

  /** Runs one user turn to completion. */
  async run(userInput: string): Promise<TurnResult> {
    this.push({ role: "user", content: userInput });
    let toolCalls = 0;
    for (let turn = 1; turn <= this.o.cfg.max_turns; turn++) {
      const result = await this.o.provider.complete(this.messages, TOOL_SPECS, { model: this.o.cfg.model, signal: this.o.signal });
      const assistant: ChatMessage = { role: "assistant", content: result.content };
      if (result.toolCalls.length) assistant.tool_calls = result.toolCalls;
      this.push(assistant);
      if (result.content.trim()) {
        this.o.ui.assistant(result.content);
        this.o.onEvent?.({ type: "assistant", content: result.content });
      }
      if (!result.toolCalls.length) {
        this.o.onEvent?.({ type: "turn_end", turns: turn, toolCalls });
        return { finalMessage: result.content, turns: turn, toolCalls };
      }
      for (const call of result.toolCalls) {
        toolCalls++;
        if (this.o.signal?.aborted) {
          this.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "error: cancelled by user" });
          continue;
        }
        const started = Date.now();
        this.o.onEvent?.({ type: "tool_start", id: call.id, name: call.name, args: safeArgs(call.arguments), title: toolTitle(call) });
        const output = await this.execute(call);
        this.o.onEvent?.({ type: "tool_end", id: call.id, name: call.name, output, ok: !/^error:/.test(output), durationMs: Date.now() - started });
        this.push({ role: "tool", tool_call_id: call.id, name: call.name, content: output });
      }
      if (this.o.signal?.aborted) {
        this.o.onEvent?.({ type: "turn_end", turns: turn, toolCalls });
        return { finalMessage: "(cancelled)", turns: turn, toolCalls };
      }
    }
    const msg = `Stopped after ${this.o.cfg.max_turns} turns without a final answer (max_turns).`;
    this.o.ui.warn(msg);
    this.o.onEvent?.({ type: "turn_end", turns: this.o.cfg.max_turns, toolCalls });
    return { finalMessage: msg, turns: this.o.cfg.max_turns, toolCalls };
  }

  private push(m: ChatMessage): void {
    this.messages.push(m);
    this.o.session?.append(m);
  }

  private async execute(call: ToolCall): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
    } catch (err) {
      return `error: could not parse arguments for ${call.name}: ${(err as Error).message}`;
    }
    try {
      switch (call.name) {
        case "shell":
          return await this.shell(String(args.command ?? ""), typeof args.timeout_ms === "number" ? args.timeout_ms : undefined);
        case "read_file": {
          const p = String(args.path ?? "");
          this.o.ui.tool(`read_file ${p}`);
          return readFileTool(this.o.cwd, { path: p, offset: num(args.offset), limit: num(args.limit) });
        }
        case "list_dir": {
          const p = args.path ? String(args.path) : ".";
          this.o.ui.tool(`list_dir ${p}`);
          return listDirTool(this.o.cwd, { path: p, depth: num(args.depth) });
        }
        case "write_file":
          return await this.writeFile(String(args.path ?? ""), String(args.content ?? ""));
        case "apply_patch":
          return await this.applyPatch(String(args.patch ?? ""));
        default:
          return `error: unknown tool ${call.name}`;
      }
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  private async gate(action: ActionRequest, title: string, detail?: string): Promise<boolean> {
    const decision = decide(action, this.policy);
    if (decision === "allow") return true;
    if (decision === "deny") {
      this.o.ui.warn(`✗ denied by policy: ${title}`);
      return false;
    }
    const answer = await this.o.ui.confirm(`Allow ${title}?`, detail);
    if (answer === "always" && action.kind === "shell") this.policy.trustedPrefixes.push(commandPrefix(action.command));
    if (answer === "no") this.o.ui.warn(`✗ not approved: ${title}`);
    return answer !== "no";
  }

  private async shell(command: string, timeoutMs?: number): Promise<string> {
    if (!command.trim()) return "error: empty command";
    const action: ActionRequest = { kind: "shell", command, cwd: this.o.cwd };
    if (!(await this.gate(action, `shell: ${command}`))) return `error: command not approved by user: ${command}`;
    this.o.ui.tool(`$ ${command}`);
    const timeout = timeoutMs ?? this.o.cfg.shell_timeout_ms;
    let result = await runShell(command, { cwd: this.o.cwd, timeoutMs: timeout, sandbox: this.sandbox });
    if (result.sandboxed && looksLikeSandboxDenial(result.stderr, result.exitCode) && this.policy.approval !== "never") {
      const retry = await this.o.ui.confirm(`The sandbox blocked "${command}". Retry without the sandbox?`, result.stderr.trim().slice(0, 500));
      if (retry !== "no") {
        result = await runShell(command, { cwd: this.o.cwd, timeoutMs: timeout, sandbox: { ...this.sandbox, mode: "danger-full-access" } });
      }
    }
    const formatted = formatShellResult(result);
    this.o.ui.tool(`exit ${result.exitCode ?? "signal"}`, result.stdout || result.stderr ? (result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim() : undefined);
    return formatted;
  }

  private async writeFile(rel: string, content: string): Promise<string> {
    if (!rel) return "error: path is required";
    const abs = path.resolve(this.o.cwd, rel);
    if (!(await this.gate({ kind: "write", path: abs }, `write ${rel}`, content.slice(0, 800)))) return `error: write not approved: ${rel}`;
    this.o.ui.tool(`write_file ${rel}`);
    return writeFileTool(this.o.cwd, { path: rel, content });
  }

  private async applyPatch(patch: string): Promise<string> {
    let ops;
    try {
      ops = parsePatch(patch);
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
    for (const op of ops) {
      const abs = path.resolve(this.o.cwd, op.path);
      const kind = op.type === "delete" ? "delete" : "write";
      if (!(await this.gate({ kind, path: abs }, `${op.type} ${op.path}`, patch.slice(0, 1200)))) return `error: patch not approved (${op.type} ${op.path})`;
      if (op.type === "update" && op.moveTo) {
        const dest = path.resolve(this.o.cwd, op.moveTo);
        if (!(await this.gate({ kind: "write", path: dest }, `move ${op.path} → ${op.moveTo}`))) return `error: move not approved`;
      }
    }
    try {
      const { summary } = applyPatchToDisk(ops, this.o.cwd, (abs) => {
        // Belt and braces: the sandbox policy still refuses paths outside the writable roots under `never`.
        if (this.policy.approval === "never" && this.policy.sandbox !== "danger-full-access" && !isInsideRoots(abs, [this.o.cwd, ...this.policy.writableRoots]))
          throw new PatchError(`refusing to write outside the workspace: ${abs}`);
      });
      this.o.ui.tool("apply_patch", summary.join("\n"));
      return `Done!\n${summary.join("\n")}`;
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function safeArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return { raw };
  }
}

/** One-line human title for a tool call, e.g. `$ npm test` or `read_file src/app.ts`. */
export function toolTitle(call: ToolCall): string {
  const a = safeArgs(call.arguments);
  switch (call.name) {
    case "shell": return `$ ${String(a.command ?? "")}`;
    case "read_file": return `read ${String(a.path ?? "")}`;
    case "list_dir": return `list ${String(a.path ?? ".")}`;
    case "write_file": return `write ${String(a.path ?? "")}`;
    case "apply_patch": {
      const files = [...String(a.patch ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]);
      return files.length ? `edit ${files.join(", ")}` : "apply_patch";
    }
    default: return call.name;
  }
}
