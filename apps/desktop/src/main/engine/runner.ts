import fs from "node:fs";
import path from "node:path";
import {
  Agent, MockProvider, OpenAIProvider, Session, defaultConfig, discoverInstructions, renderInstructions, systemPrompt,
  type ApprovalAnswer as CoreAnswer, type ModexConfig, type Provider, type UI,
} from "@modex/core";
import type { ApprovalAnswer, Mode, Settings, Thread, ThreadEvent, ThreadItem, ThreadStatus } from "../../shared/types.js";
import { Store, newId } from "./store.js";
import * as gitx from "./git.js";

/** Codex-App-style modes mapped onto the engine's approval + sandbox policies. */
export function policyForMode(mode: Mode): Pick<ModexConfig, "approval_policy" | "sandbox_mode"> {
  switch (mode) {
    case "chat": return { approval_policy: "untrusted", sandbox_mode: "read-only" };
    case "agent": return { approval_policy: "on-request", sandbox_mode: "workspace-write" };
    case "full-access": return { approval_policy: "never", sandbox_mode: "danger-full-access" };
  }
}

export type ProviderFactory = (settings: Settings, model: string) => Provider;

export function defaultProviderFactory(settings: Settings, _model: string): Provider {
  if (settings.provider === "mock") {
    if (!settings.mock_script) throw new Error("Mock provider selected but no mock script is configured (Settings → Mock script).");
    return MockProvider.fromFile(settings.mock_script);
  }
  const key = process.env.MODEX_API_KEY ?? process.env[settings.api_key_env];
  if (!key && /api\.openai\.com/.test(settings.base_url)) {
    throw new Error(`No API key: set ${settings.api_key_env} (or MODEX_API_KEY) in the environment Modex was launched from, or point Settings → Base URL at a local server.`);
  }
  return new OpenAIProvider(settings.base_url, key);
}

interface Live {
  agent: Agent | null;
  abort: AbortController | null;
  pending: Map<string, (a: CoreAnswer) => void>;
  items: ThreadItem[];
  status: ThreadStatus;
}

export interface RunnerOptions {
  home: string;
  store: Store;
  emit: (event: ThreadEvent) => void;
  providerFactory?: ProviderFactory;
}

/**
 * Owns every thread's agent. Threads run independently and concurrently; each turn is
 * a `@modex/core` Agent run whose UI callbacks are turned into ThreadEvents for the renderer.
 */
export class ThreadRunner {
  private readonly live = new Map<string, Live>();
  private readonly makeProvider: ProviderFactory;

  constructor(private readonly o: RunnerOptions) {
    this.makeProvider = o.providerFactory ?? defaultProviderFactory;
  }

  private slot(threadId: string): Live {
    let l = this.live.get(threadId);
    if (!l) {
      l = { agent: null, abort: null, pending: new Map(), items: this.o.store.items(threadId), status: "idle" };
      this.live.set(threadId, l);
    }
    return l;
  }

  items(threadId: string): ThreadItem[] {
    return [...this.slot(threadId).items];
  }

  status(threadId: string): ThreadStatus {
    return this.slot(threadId).status;
  }

  async createThread(projectId: string, opts: { worktree?: boolean; mode?: Mode; model?: string } = {}): Promise<Thread> {
    const project = this.o.store.project(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const settings = this.o.store.settings;
    const id = newId();
    const now = new Date().toISOString();
    let cwd = project.path;
    let worktree: Thread["worktree"];
    if (opts.worktree) {
      const branch = `modex/${id}`;
      const dest = path.join(this.o.home, "worktrees", project.name, id);
      worktree = await gitx.worktreeAdd(project.path, dest, branch);
      cwd = dest;
    }
    const thread: Thread = {
      id, projectId, title: "New thread", createdAt: now, updatedAt: now, cwd, worktree,
      mode: opts.mode ?? settings.default_mode, model: opts.model ?? settings.default_model, status: "idle",
    };
    this.o.store.addThread(thread);
    return thread;
  }

  async deleteThread(threadId: string, removeWorktree = false): Promise<void> {
    const thread = this.o.store.thread(threadId);
    this.stop(threadId);
    this.live.delete(threadId);
    if (thread?.worktree && removeWorktree) {
      const project = this.o.store.project(thread.projectId);
      if (project) await gitx.worktreeRemove(project.path, thread.worktree.path);
    }
    this.o.store.deleteThread(threadId);
  }

  /** Runs one user turn. Resolves when the agent is idle again (or errored). */
  async send(threadId: string, text: string): Promise<void> {
    const thread = this.o.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const l = this.slot(threadId);
    if (l.status === "running" || l.status === "waiting") throw new Error("This thread is still working. Stop it or wait for it to finish.");
    if (!fs.existsSync(thread.cwd)) throw new Error(`working directory is missing: ${thread.cwd}`);

    const settings = this.o.store.settings;
    const cfg: ModexConfig = { ...defaultConfig({ MODEX_HOME: this.o.home }), ...policyForMode(thread.mode), model: thread.model, home: this.o.home };
    if (settings.provider === "mock") cfg.provider = { name: "mock", base_url: "", api_key_env: "" };
    else cfg.provider = { name: "openai", base_url: settings.base_url, api_key_env: settings.api_key_env };

    this.addItem(threadId, { id: newId(), kind: "user", text, at: new Date().toISOString() });
    if (thread.title === "New thread") this.updateThread(threadId, { title: text.replace(/\s+/g, " ").trim().slice(0, 60) || "New thread" });

    let provider: Provider;
    try {
      provider = this.makeProvider(settings, thread.model);
    } catch (err) {
      this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: (err as Error).message, at: new Date().toISOString() });
      this.setStatus(threadId, "error");
      return;
    }

    const loaded = thread.sessionId ? Session.load(this.o.home, thread.sessionId) : null;
    const session = loaded?.session ?? Session.create(this.o.home, thread.cwd, thread.model);
    if (!thread.sessionId) this.o.store.updateThread(threadId, { sessionId: session.meta.id });

    const abort = new AbortController();
    l.abort = abort;
    const ui = this.uiFor(threadId);
    const agent = new Agent({
      cfg, provider, ui, cwd: thread.cwd, session, signal: abort.signal,
      systemPrompt: systemPrompt(cfg, thread.cwd, renderInstructions(discoverInstructions(thread.cwd, this.o.home))).replace("terminal coding agent", "coding agent running inside the Modex desktop app"),
      history: l.agent?.messages ?? loaded?.messages,
      onEvent: (e) => {
        const at = new Date().toISOString();
        if (e.type === "assistant") this.addItem(threadId, { id: newId(), kind: "assistant", text: e.content, at });
        else if (e.type === "tool_start") this.addItem(threadId, { id: e.id, kind: "tool", name: e.name, title: e.title, args: redact(e.args), status: "running", at });
        else if (e.type === "tool_end") this.patchItem(threadId, e.id, { output: e.output, ok: e.ok, status: "done", durationMs: e.durationMs });
      },
    });
    l.agent = agent;
    this.setStatus(threadId, "running");
    try {
      await agent.run(text);
      this.setStatus(threadId, "idle");
    } catch (err) {
      const message = abort.signal.aborted ? "Stopped." : (err as Error).message;
      this.addItem(threadId, { id: newId(), kind: "notice", level: abort.signal.aborted ? "info" : "error", text: message, at: new Date().toISOString() });
      this.setStatus(threadId, abort.signal.aborted ? "idle" : "error");
    } finally {
      l.abort = null;
      for (const resolve of l.pending.values()) resolve("no");
      l.pending.clear();
    }
  }

  stop(threadId: string): void {
    const l = this.live.get(threadId);
    if (!l) return;
    l.abort?.abort();
    for (const [itemId, resolve] of l.pending) {
      this.patchItem(threadId, itemId, { answer: "no" });
      resolve("no");
    }
    l.pending.clear();
  }

  answer(threadId: string, itemId: string, answer: ApprovalAnswer): void {
    const l = this.slot(threadId);
    const resolve = l.pending.get(itemId);
    if (!resolve) return;
    l.pending.delete(itemId);
    this.patchItem(threadId, itemId, { answer });
    if (l.pending.size === 0 && l.status === "waiting") this.setStatus(threadId, "running");
    resolve(answer);
  }

  updateThread(threadId: string, patch: Partial<Pick<Thread, "mode" | "model" | "title">>): Thread {
    const t = this.o.store.updateThread(threadId, patch);
    this.o.emit({ threadId, type: "thread", thread: t });
    return t;
  }

  private uiFor(threadId: string): UI {
    const at = () => new Date().toISOString();
    return {
      info: (m) => this.addItem(threadId, { id: newId(), kind: "notice", level: "info", text: m, at: at() }),
      assistant: () => {},
      tool: () => {},
      warn: (m) => this.addItem(threadId, { id: newId(), kind: "notice", level: "warn", text: m, at: at() }),
      error: (m) => this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: m, at: at() }),
      confirm: (question, detail) =>
        new Promise<CoreAnswer>((resolve) => {
          const l = this.slot(threadId);
          if (l.abort?.signal.aborted) return resolve("no");
          const id = newId();
          l.pending.set(id, resolve);
          this.addItem(threadId, { id, kind: "approval", question, detail, at: at() });
          this.setStatus(threadId, "waiting");
        }),
      prompt: async () => null,
      close: () => {},
    };
  }

  private addItem(threadId: string, item: ThreadItem): void {
    const l = this.slot(threadId);
    l.items.push(item);
    this.o.store.saveItems(threadId, l.items);
    this.o.emit({ threadId, type: "item", item });
  }

  private patchItem(threadId: string, id: string, patch: Partial<ThreadItem>): void {
    const l = this.slot(threadId);
    const idx = l.items.findIndex((i) => i.id === id);
    if (idx >= 0) l.items[idx] = { ...l.items[idx], ...patch } as ThreadItem;
    this.o.store.saveItems(threadId, l.items);
    this.o.emit({ threadId, type: "item_update", id, patch });
  }

  private setStatus(threadId: string, status: ThreadStatus): void {
    const l = this.slot(threadId);
    l.status = status;
    if (this.o.store.thread(threadId)) this.o.store.updateThread(threadId, { status });
    this.o.emit({ threadId, type: "status", status });
  }
}

/** Keeps tool args small enough for the UI: long strings are truncated. */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" && v.length > 4000 ? v.slice(0, 4000) + "…" : v;
  return out;
}
