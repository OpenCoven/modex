import fs from "node:fs";
import path from "node:path";
import type { ApprovalAnswer, BackendId, Mode, ModelInfo, Thread, ThreadEvent, ThreadItem, ThreadStatus } from "../../shared/types.js";
import { Store, newId } from "./store.js";
import * as gitx from "./git.js";
import type { Backend, TurnSink } from "./backends/types.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import { MockBackend } from "./backends/mock.js";

interface Live {
  abort: AbortController | null;
  pending: Map<string, (a: ApprovalAnswer) => void>;
  items: ThreadItem[];
  status: ThreadStatus;
  /** Assistant item currently receiving streamed text, if any. */
  streaming: { id: string; text: string } | null;
}

export interface RunnerOptions {
  home: string;
  store: Store;
  emit: (event: ThreadEvent) => void;
  /** Override backends (tests inject fakes). */
  backends?: Partial<Record<BackendId, Backend>>;
}

/**
 * Owns every thread. Threads run independently and concurrently; each turn is delegated to
 * the thread's backend (Claude CLI, Codex CLI, or the offline mock engine) whose callbacks are
 * turned into ThreadEvents for the renderer and persisted as items.
 */
export class ThreadRunner {
  private readonly live = new Map<string, Live>();
  private readonly backends: Record<BackendId, Backend>;

  constructor(private readonly o: RunnerOptions) {
    const s = () => o.store.settings;
    this.backends = {
      claude: o.backends?.claude ?? new ClaudeBackend(s().claude_bin),
      codex: o.backends?.codex ?? new CodexBackend(s().codex_bin),
      mock: o.backends?.mock ?? new MockBackend(() => s().mock_script, o.home),
    };
  }

  backend(id: BackendId): Backend {
    return this.backends[id];
  }

  async listModels(id: BackendId): Promise<{ models: ModelInfo[]; error?: string }> {
    try {
      return { models: await this.backends[id].listModels() };
    } catch (err) {
      return { models: [], error: (err as Error).message };
    }
  }

  async dispose(): Promise<void> {
    for (const t of this.live.keys()) this.stop(t);
    await Promise.all(Object.values(this.backends).map((b) => b.dispose()));
  }

  private slot(threadId: string): Live {
    let l = this.live.get(threadId);
    if (!l) {
      l = { abort: null, pending: new Map(), items: this.o.store.items(threadId), status: "idle", streaming: null };
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

  async createThread(projectId: string, opts: { worktree?: boolean; mode?: Mode; model?: string; backend?: BackendId } = {}): Promise<Thread> {
    const project = this.o.store.project(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const settings = this.o.store.settings;
    const backend = opts.backend ?? settings.default_backend;
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
      backend, mode: opts.mode ?? settings.default_mode, plan: false,
      model: opts.model ?? settings.default_model[backend] ?? "", status: "idle",
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

  /** Runs one user turn. Resolves when the thread is idle again (or errored). */
  async send(threadId: string, text: string): Promise<void> {
    const thread = this.o.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const l = this.slot(threadId);
    if (l.status === "running" || l.status === "waiting") throw new Error("This thread is still working. Stop it or wait for it to finish.");
    if (!fs.existsSync(thread.cwd)) throw new Error(`working directory is missing: ${thread.cwd}`);

    this.addItem(threadId, { id: newId(), kind: "user", text, at: new Date().toISOString() });
    if (thread.title === "New thread") this.updateThread(threadId, { title: text.replace(/\s+/g, " ").trim().slice(0, 60) || "New thread" });

    const abort = new AbortController();
    l.abort = abort;
    l.streaming = null;
    const backend = this.backends[thread.backend];
    const sink = this.sinkFor(threadId, l);
    this.setStatus(threadId, "running");
    try {
      const result = await backend.runTurn(
        text,
        { cwd: thread.cwd, mode: thread.mode, plan: thread.plan, model: thread.model, effort: thread.effort, resume: thread.sessionHandle, addDirs: thread.worktree ? [] : [] },
        sink,
        abort.signal,
      );
      if (result.status === "failed") {
        this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: result.error ?? "The turn failed.", at: new Date().toISOString() });
        this.setStatus(threadId, "error");
      } else {
        if (result.status === "interrupted") this.addItem(threadId, { id: newId(), kind: "notice", level: "info", text: "Stopped.", at: new Date().toISOString() });
        this.setStatus(threadId, "idle");
      }
    } catch (err) {
      this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: (err as Error).message, at: new Date().toISOString() });
      this.setStatus(threadId, "error");
    } finally {
      l.abort = null;
      l.streaming = null;
      for (const resolve of l.pending.values()) resolve("no");
      l.pending.clear();
    }
  }

  stop(threadId: string): void {
    const l = this.live.get(threadId);
    if (!l) return;
    for (const [itemId, resolve] of l.pending) {
      this.patchItem(threadId, itemId, { answer: "no" });
      resolve("no");
    }
    l.pending.clear();
    l.abort?.abort();
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

  updateThread(threadId: string, patch: Partial<Pick<Thread, "mode" | "model" | "title" | "backend" | "plan" | "effort">>): Thread {
    const current = this.o.store.thread(threadId);
    // Switching backend starts a fresh backend conversation; the transcript stays.
    const extra: Partial<Thread> = current && patch.backend && patch.backend !== current.backend ? { sessionHandle: undefined, model: this.o.store.settings.default_model[patch.backend] ?? "", effort: undefined } : {};
    const t = this.o.store.updateThread(threadId, { ...extra, ...patch });
    this.o.emit({ threadId, type: "thread", thread: t });
    return t;
  }

  private sinkFor(threadId: string, l: Live): TurnSink {
    const at = () => new Date().toISOString();
    return {
      delta: (text) => {
        if (!l.streaming) {
          l.streaming = { id: newId(), text: "" };
          this.addItem(threadId, { id: l.streaming.id, kind: "assistant", text: "", at: at() });
        }
        l.streaming.text += text;
        this.patchItem(threadId, l.streaming.id, { text: l.streaming.text }, { persist: false });
      },
      assistant: (text) => {
        if (l.streaming) this.patchItem(threadId, l.streaming.id, { text });
        else if (text.trim()) this.addItem(threadId, { id: newId(), kind: "assistant", text, at: at() });
        l.streaming = null;
      },
      toolStart: (t) => {
        l.streaming = null;
        this.addItem(threadId, { id: t.id, kind: "tool", name: t.name, title: t.title, args: redact(t.args), status: "running", at: at() });
      },
      toolUpdate: (id, patch) => this.patchItem(threadId, id, patch),
      approval: (req) =>
        new Promise<ApprovalAnswer>((resolve) => {
          if (l.abort?.signal.aborted) return resolve("no");
          const id = newId();
          l.pending.set(id, resolve);
          this.addItem(threadId, { id, kind: "approval", question: req.question, detail: req.detail, canAlways: req.canAlways, at: at() });
          this.setStatus(threadId, "waiting");
        }),
      notice: (level, text) => this.addItem(threadId, { id: newId(), kind: "notice", level, text, at: at() }),
      thinkingDelta: (id, delta) => {
        const existing = l.items.find((i) => i.id === id && i.kind === "thinking") as Extract<ThreadItem, { kind: "thinking" }> | undefined;
        // Backends announce a reasoning block before any text exists. The row appears immediately
        // ("Thinking…") so the user sees the model reasoning; if the CLI never shares the text the
        // finished row stays as a compact "Thought for Ns" line and says so when expanded.
        if (!existing) {
          l.streaming = null;
          this.addItem(threadId, { id, kind: "thinking", text: delta, status: "running", at: at() });
        } else this.patchItem(threadId, id, { text: existing.text + delta }, { persist: false });
      },
      thinkingDone: (id, text) => {
        const existing = l.items.find((i) => i.id === id && i.kind === "thinking") as Extract<ThreadItem, { kind: "thinking" }> | undefined;
        if (!existing) {
          // A reasoning block that only produced text at completion (no deltas) still gets an item.
          if (text?.trim()) this.addItem(threadId, { id, kind: "thinking", text, status: "done", durationMs: 0, at: at() });
          return;
        }
        this.patchItem(threadId, id, { text: text ?? existing.text, status: "done", durationMs: Date.now() - new Date(existing.at).getTime() });
      },
      session: (handle) => {
        const t = this.o.store.thread(threadId);
        if (t && t.sessionHandle !== handle) this.o.store.updateThread(threadId, { sessionHandle: handle });
      },
    };
  }

  private addItem(threadId: string, item: ThreadItem): void {
    const l = this.slot(threadId);
    l.items.push(item);
    this.o.store.saveItems(threadId, l.items);
    this.o.emit({ threadId, type: "item", item });
  }

  private patchItem(threadId: string, id: string, patch: Partial<ThreadItem>, opts: { persist?: boolean } = {}): void {
    const l = this.slot(threadId);
    const idx = l.items.findIndex((i) => i.id === id);
    if (idx >= 0) l.items[idx] = { ...l.items[idx], ...patch } as ThreadItem;
    // Streaming deltas skip the disk write; the final message persists the full text.
    if (opts.persist !== false) this.o.store.saveItems(threadId, l.items);
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
