import path from "node:path";
import type { ActionRequest, ApprovalPolicy, Decision, SandboxMode } from "./types.js";

export interface PolicyContext {
  approval: ApprovalPolicy;
  sandbox: SandboxMode;
  workspace: string;
  writableRoots: string[];
  /** Whether an OS-level sandbox (sandbox-exec) is available to constrain shell commands. */
  osSandboxAvailable: boolean;
  /** Command prefixes the user approved with "always" during this session. */
  trustedPrefixes: string[];
}

/** Commands that are read-only by construction and safe to run without asking. */
const SAFE_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "grep", "rg", "which", "type", "file", "stat",
  "tree", "diff", "sort", "uniq", "cut", "tr", "basename", "dirname", "realpath", "env", "date", "true",
  "node --version", "npm --version", "python --version", "python3 --version",
]);
const SAFE_GIT = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "blame", "ls-files", "remote", "stash list"]);
const SHELL_METACHARS = /[;&|`$<>]/;

/** True when every simple command in the pipeline is known-safe. */
export function isKnownSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Allow simple pipelines of safe commands but nothing with redirects/subshells.
  const segments = trimmed.split("|").map((s) => s.trim());
  for (const seg of segments) {
    if (SHELL_METACHARS.test(seg)) return false;
    if (SAFE_COMMANDS.has(seg)) continue;
    const words = seg.split(/\s+/);
    const cmd = words[0] ?? "";
    if (cmd === "git") {
      const sub = words[1] ?? "";
      if (!SAFE_GIT.has(sub) && !SAFE_GIT.has(`${sub} ${words[2] ?? ""}`)) return false;
      continue;
    }
    if (cmd === "find") {
      if (words.some((w) => w === "-delete" || w === "-exec" || w === "-execdir" || w === "-ok")) return false;
      continue;
    }
    if (cmd === "sed") {
      if (!words.includes("-n") || words.includes("-i")) return false;
      continue;
    }
    if (!SAFE_COMMANDS.has(cmd)) return false;
  }
  return true;
}

export function isInsideRoots(target: string, roots: string[]): boolean {
  const abs = path.resolve(target);
  return roots.some((root) => {
    const r = path.resolve(root);
    return abs === r || abs.startsWith(r + path.sep);
  });
}

export function writableRootsFor(ctx: PolicyContext): string[] {
  return [ctx.workspace, ...ctx.writableRoots];
}

/**
 * Decides whether an action may run, must be confirmed, or is refused.
 * The rules mirror Codex: read-only work never asks; workspace writes are allowed under
 * workspace-write; anything outside the sandbox asks (or is denied under `never`).
 */
export function decide(action: ActionRequest, ctx: PolicyContext): Decision {
  if (ctx.sandbox === "danger-full-access") {
    if (ctx.approval === "never") return "allow";
    if (action.kind === "shell") return ctx.approval === "untrusted" && !isKnownSafeCommand(action.command) ? "ask" : trustedOr(action, ctx, "allow");
    return "allow";
  }

  if (action.kind === "write" || action.kind === "delete") {
    const inside = isInsideRoots(action.path, writableRootsFor(ctx));
    if (inside && ctx.sandbox === "workspace-write") return "allow";
    // read-only sandbox, or a path outside the writable roots
    return ctx.approval === "never" ? "deny" : "ask";
  }

  // shell
  if (isKnownSafeCommand(action.command)) return "allow";
  if (trustedOr(action, ctx, "ask") === "allow") return "allow";
  if (ctx.approval === "untrusted") return "ask";
  if (ctx.approval === "never") return "allow"; // sandbox still constrains it; failures go back to the model
  // on-request: run without asking when the OS sandbox can enforce the policy; otherwise confirm.
  return ctx.osSandboxAvailable ? "allow" : "ask";
}

function trustedOr(action: ActionRequest, ctx: PolicyContext, fallback: Decision): Decision {
  if (action.kind !== "shell") return fallback;
  const cmd = action.command.trim();
  return ctx.trustedPrefixes.some((p) => cmd === p || cmd.startsWith(p + " ")) ? "allow" : fallback;
}

/** The "prefix" remembered when the user answers "always" — the first word (or `git <sub>`). */
export function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/);
  if (words[0] === "git" && words[1]) return `git ${words[1]}`;
  return words[0] ?? command.trim();
}
