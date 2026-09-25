/** Shared types for the Modex agent loop. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of the arguments, exactly as the model produced it. */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Present on assistant messages that request tool calls. */
  tool_calls?: ToolCall[];
  /** Present on tool messages; links the result to its call. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface CompletionOptions {
  model: string;
  signal?: AbortSignal;
  /** When provided, providers that support streaming call this with each text delta as it arrives. */
  onDelta?: (text: string) => void;
  /** Reasoning/thinking deltas, for providers that expose them. */
  onThinking?: (text: string) => void;
}

export interface Provider {
  readonly name: string;
  complete(messages: ChatMessage[], tools: ToolSpec[], opts: CompletionOptions): Promise<CompletionResult>;
}

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ModexConfig {
  model: string;
  /** Only the scripted mock provider remains in-process; real models run through the Claude/Codex CLIs. */
  provider: {
    name: "mock";
    base_url: string;
    api_key_env: string;
  };
  approval_policy: ApprovalPolicy;
  sandbox_mode: SandboxMode;
  network_access: boolean;
  /** Extra directories writable alongside the workspace. */
  writable_roots: string[];
  max_turns: number;
  shell_timeout_ms: number;
  /** Path to a mock provider script (only used when provider.name === "mock"). */
  mock_script?: string;
  home: string;
}

export type ActionRequest =
  | { kind: "shell"; command: string; cwd: string }
  | { kind: "write"; path: string }
  | { kind: "delete"; path: string };

export type Decision = "allow" | "ask" | "deny";

export type ApprovalAnswer = "yes" | "no" | "always";
