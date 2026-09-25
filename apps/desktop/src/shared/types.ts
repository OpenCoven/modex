/** Types shared between the Electron main process and the React renderer. */

export type Mode = "chat" | "agent" | "full-access";
/** Which CLI runs the thread. "mock" is the offline scripted engine used by the demo and tests. */
export type BackendId = "claude" | "codex" | "mock";
export type ThreadStatus = "idle" | "running" | "waiting" | "error";
export type ApprovalAnswer = "yes" | "no" | "always";

export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Directory the agent works in: the project path or a dedicated worktree. */
  cwd: string;
  worktree?: { path: string; branch: string };
  backend: BackendId;
  mode: Mode;
  /** Plan mode: read-only investigation that ends in a plan instead of edits. */
  plan: boolean;
  model: string;
  /** Reasoning effort for backends that support it (Codex). */
  effort?: string;
  /** Backend resume handle: Claude session id or Codex thread id. */
  sessionHandle?: string;
  status: ThreadStatus;
}

export type ThreadItem =
  | { id: string; kind: "user"; text: string; at: string }
  | { id: string; kind: "assistant"; text: string; at: string }
  | { id: string; kind: "tool"; name: string; title: string; args: Record<string, unknown>; output?: string; ok?: boolean; status: "running" | "done"; durationMs?: number; at: string }
  | { id: string; kind: "approval"; question: string; detail?: string; canAlways?: boolean; answer?: ApprovalAnswer; at: string }
  | { id: string; kind: "notice"; level: "info" | "warn" | "error"; text: string; at: string }
  /** Model reasoning: Codex reasoning summaries or Claude extended thinking. Collapsible in the UI. */
  | { id: string; kind: "thinking"; text: string; status: "running" | "done"; durationMs?: number; at: string };

export type ThreadEvent =
  | { threadId: string; type: "item"; item: ThreadItem }
  | { threadId: string; type: "item_update"; id: string; patch: Partial<ThreadItem> }
  | { threadId: string; type: "status"; status: ThreadStatus }
  | { threadId: string; type: "thread"; thread: Thread };

export interface Settings {
  /** Backend for new threads. */
  default_backend: BackendId;
  default_mode: Mode;
  /** Default model per backend (empty = the CLI's own default). */
  default_model: Record<BackendId, string>;
  /** Executables; plain names resolve on PATH. */
  claude_bin: string;
  codex_bin: string;
  /** Scripted engine for the offline demo/tests. */
  mock_script?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  efforts?: string[];
  defaultEffort?: string;
}

export const BACKENDS: { id: BackendId; label: string; hint: string }[] = [
  { id: "codex", label: "Codex", hint: "OpenAI Codex CLI (codex app-server) — uses your `codex login`" },
  { id: "claude", label: "Claude", hint: "Claude Code CLI (claude -p) — uses your `claude` login" },
];

export interface AppState {
  version: 1;
  projects: Project[];
  threads: Thread[];
  settings: Settings;
}

export interface ChangedFile {
  path: string;
  /** Two-letter porcelain code, e.g. " M", "??", "A ", " D", "R ". */
  code: string;
  additions: number;
  deletions: number;
}

export interface ChangesSnapshot {
  cwd: string;
  isRepo: boolean;
  branch: string | null;
  files: ChangedFile[];
}

export const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Read-only. Asks before any command or edit." },
  { id: "agent", label: "Agent", hint: "Edits and runs commands inside the project; asks to go outside it." },
  { id: "full-access", label: "Agent (full access)", hint: "No sandbox, no prompts. Only in a trusted environment." },
];


/** The API the preload exposes to the renderer as `window.modex`. */
export interface ModexBridge {
  invoke<K extends keyof BridgeCommands>(channel: K, payload: BridgeCommands[K]["req"]): Promise<BridgeCommands[K]["res"]>;
  onEvent(cb: (event: ThreadEvent) => void): () => void;
  platform: string;
}

export interface BridgeCommands {
  "state:get": { req: undefined; res: AppState };
  "project:add": { req: { path?: string } | undefined; res: Project | null };
  "project:remove": { req: { projectId: string }; res: AppState };
  "thread:create": { req: { projectId: string; worktree?: boolean; mode?: Mode; model?: string; backend?: BackendId }; res: Thread };
  "thread:items": { req: { threadId: string }; res: ThreadItem[] };
  "thread:send": { req: { threadId: string; text: string }; res: { ok: boolean; error?: string } };
  "thread:stop": { req: { threadId: string }; res: void };
  "thread:answer": { req: { threadId: string; itemId: string; answer: ApprovalAnswer }; res: void };
  "thread:update": { req: { threadId: string; patch: Partial<Pick<Thread, "mode" | "model" | "title" | "backend" | "plan" | "effort">> }; res: Thread };
  "models:list": { req: { backend: BackendId }; res: { models: ModelInfo[]; error?: string } };
  "backends:health": { req: undefined; res: Record<BackendId, { ok: boolean; detail: string }> };
  "thread:delete": { req: { threadId: string; removeWorktree?: boolean }; res: AppState };
  "changes:status": { req: { threadId: string }; res: ChangesSnapshot };
  "changes:diff": { req: { threadId: string; path: string }; res: string };
  "changes:revert": { req: { threadId: string; path: string }; res: ChangesSnapshot };
  "settings:update": { req: Partial<Settings>; res: Settings };
  "shell:openPath": { req: { path: string }; res: void };
}
