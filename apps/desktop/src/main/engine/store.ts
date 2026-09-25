import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AppState, Project, Settings, Thread, ThreadItem } from "../../shared/types.js";

export const DEFAULT_SETTINGS: Settings = {
  provider: "openai",
  base_url: "https://api.openai.com/v1",
  api_key_env: "OPENAI_API_KEY",
  default_model: "gpt-5-codex",
  default_mode: "agent",
};

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** JSON-file persistence for the app shell: projects, threads, settings, and per-thread UI items. */
export class Store {
  readonly dir: string;
  private state: AppState;

  constructor(readonly home: string) {
    this.dir = path.join(home, "app");
    fs.mkdirSync(path.join(this.dir, "threads"), { recursive: true });
    this.state = this.read();
  }

  private get file(): string {
    return path.join(this.dir, "state.json");
  }

  private read(): AppState {
    if (!fs.existsSync(this.file)) return { version: 1, projects: [], threads: [], settings: { ...DEFAULT_SETTINGS } };
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<AppState>;
    return {
      version: 1,
      projects: raw.projects ?? [],
      // Nothing is running when the app starts.
      threads: (raw.threads ?? []).map((t) => ({ ...t, status: "idle" as const })),
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
  }

  private write(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  snapshot(): AppState {
    return structuredClone(this.state);
  }

  get settings(): Settings {
    return { ...this.state.settings };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.state.settings = { ...this.state.settings, ...patch };
    this.write();
    return this.settings;
  }

  addProject(dir: string): Project {
    const abs = path.resolve(dir);
    const existing = this.state.projects.find((p) => p.path === abs);
    if (existing) return existing;
    const project: Project = { id: newId(), name: path.basename(abs), path: abs, addedAt: new Date().toISOString() };
    this.state.projects.push(project);
    this.write();
    return project;
  }

  removeProject(projectId: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== projectId);
    for (const t of this.state.threads.filter((t) => t.projectId === projectId)) this.deleteThreadFiles(t.id);
    this.state.threads = this.state.threads.filter((t) => t.projectId !== projectId);
    this.write();
  }

  project(projectId: string): Project | undefined {
    return this.state.projects.find((p) => p.id === projectId);
  }

  thread(threadId: string): Thread | undefined {
    return this.state.threads.find((t) => t.id === threadId);
  }

  addThread(thread: Thread): Thread {
    this.state.threads.unshift(thread);
    this.write();
    return thread;
  }

  updateThread(threadId: string, patch: Partial<Thread>): Thread {
    const t = this.thread(threadId);
    if (!t) throw new Error(`unknown thread ${threadId}`);
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    this.write();
    return { ...t };
  }

  deleteThread(threadId: string): void {
    this.state.threads = this.state.threads.filter((t) => t.id !== threadId);
    this.deleteThreadFiles(threadId);
    this.write();
  }

  private itemsFile(threadId: string): string {
    return path.join(this.dir, "threads", `${threadId}.json`);
  }

  items(threadId: string): ThreadItem[] {
    const f = this.itemsFile(threadId);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as ThreadItem[]) : [];
  }

  saveItems(threadId: string, items: ThreadItem[]): void {
    fs.writeFileSync(this.itemsFile(threadId), JSON.stringify(items));
  }

  private deleteThreadFiles(threadId: string): void {
    fs.rmSync(this.itemsFile(threadId), { force: true });
  }
}
