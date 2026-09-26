import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AppState, BackendId, EffortLevel, Project, RoutingPolicy, Settings, Thread, ThreadItem } from "../../shared/types.js";
import { DEFAULT_ROUTING, EFFORT_LEVELS } from "../../shared/types.js";

export const DEFAULT_SETTINGS: Settings = {
  default_backend: "codex",
  default_mode: "agent",
  default_model: { codex: "", claude: "", mock: "mock" },
  claude_bin: "claude",
  codex_bin: "codex",
  routing: { ...DEFAULT_ROUTING },
};

/** Fills in and type-checks the routing policy; anything odd falls back to the default. */
export function migrateRouting(raw: unknown): RoutingPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_ROUTING;
  const isBackend = (b: unknown): b is BackendId => b === "claude" || b === "codex" || b === "mock";
  const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);
  return {
    auto_by_default: typeof r.auto_by_default === "boolean" ? r.auto_by_default : d.auto_by_default,
    posture: r.posture === "economy" || r.posture === "balanced" || r.posture === "quality" ? r.posture : d.posture,
    allow_backends: Array.isArray(r.allow_backends) ? (r.allow_backends.filter(isBackend) as BackendId[]) : [...d.allow_backends],
    allow_backend_switch: typeof r.allow_backend_switch === "boolean" ? r.allow_backend_switch : d.allow_backend_switch,
    max_effort: EFFORT_LEVELS.includes(r.max_effort as EffortLevel) ? (r.max_effort as EffortLevel) : d.max_effort,
    allow_fast: typeof r.allow_fast === "boolean" ? r.allow_fast : d.allow_fast,
    min_confidence: num(r.min_confidence, 0, 1, d.min_confidence),
    premium_turns_per_day: r.premium_turns_per_day === null ? null : typeof r.premium_turns_per_day === "number" && r.premium_turns_per_day >= 0 ? Math.floor(r.premium_turns_per_day) : d.premium_turns_per_day,
    jev_model: typeof r.jev_model === "string" && r.jev_model.trim() ? r.jev_model.trim() : d.jev_model,
    jev_transport: r.jev_transport === "auto" || r.jev_transport === "cli" || r.jev_transport === "http" ? r.jev_transport : d.jev_transport,
    jev_bin: typeof r.jev_bin === "string" && r.jev_bin.trim() ? r.jev_bin.trim() : d.jev_bin,
  };
}

/** Accepts older state files (pre-CLI-backend settings) and fills in defaults. */
export function migrateSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const model = r.default_model;
  return {
    ...DEFAULT_SETTINGS,
    default_backend: r.default_backend === "claude" || r.default_backend === "codex" || r.default_backend === "mock" ? r.default_backend : DEFAULT_SETTINGS.default_backend,
    default_mode: r.default_mode === "chat" || r.default_mode === "agent" || r.default_mode === "full-access" ? r.default_mode : DEFAULT_SETTINGS.default_mode,
    default_model: model && typeof model === "object" ? { ...DEFAULT_SETTINGS.default_model, ...(model as Record<string, string>) } : { ...DEFAULT_SETTINGS.default_model },
    claude_bin: typeof r.claude_bin === "string" && r.claude_bin ? r.claude_bin : DEFAULT_SETTINGS.claude_bin,
    codex_bin: typeof r.codex_bin === "string" && r.codex_bin ? r.codex_bin : DEFAULT_SETTINGS.codex_bin,
    ...(typeof r.mock_script === "string" ? { mock_script: r.mock_script } : {}),
    routing: migrateRouting(r.routing),
  };
}

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
      threads: (raw.threads ?? []).map((t) => ({ ...t, backend: (t as Partial<Thread>).backend ?? ("codex" as const), plan: (t as Partial<Thread>).plan ?? false, status: "idle" as const })),
      settings: migrateSettings(raw.settings),
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
    this.state.settings = { ...this.state.settings, ...patch, ...(patch.routing ? { routing: migrateRouting({ ...this.state.settings.routing, ...patch.routing }) } : {}) };
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
