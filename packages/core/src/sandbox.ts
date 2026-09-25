/**
 * OS-level sandboxing for shell commands. On macOS this wraps the command in
 * `sandbox-exec` with a Seatbelt profile, the same mechanism Codex uses; elsewhere
 * commands run unsandboxed and the policy layer falls back to asking.
 */
import fs from "node:fs";
import path from "node:path";
import type { SandboxMode } from "./types.js";

export interface SandboxSpec {
  mode: SandboxMode;
  writableRoots: string[];
  networkAccess: boolean;
}

export function osSandboxAvailable(platform = process.platform): boolean {
  return platform === "darwin" && fs.existsSync("/usr/sbin/sandbox-exec");
}

function sbEscape(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Builds a Seatbelt (SBPL) profile for the requested mode. */
export function seatbeltProfile(spec: SandboxSpec): string {
  const lines = ["(version 1)", "(allow default)"];
  if (spec.mode !== "danger-full-access") {
    lines.push("(deny file-write*)");
    // Shells and tools need a few pseudo-devices to function.
    lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/") (literal "/dev/stdout") (literal "/dev/stderr"))');
    if (spec.mode === "workspace-write") {
      const roots = [...spec.writableRoots, "/tmp", "/private/tmp", process.env.TMPDIR ?? "/private/var/folders"].map((r) =>
        `(subpath ${sbEscape(realpathSafe(r))})`,
      );
      lines.push(`(allow file-write* ${roots.join(" ")})`);
      // Deny writes to VCS metadata inside the workspace so the model cannot rewrite history.
      const gitDirs = spec.writableRoots.map((r) => `(subpath ${sbEscape(path.join(realpathSafe(r), ".git"))})`);
      if (gitDirs.length) lines.push(`(deny file-write* ${gitDirs.join(" ")})`);
    }
    if (!spec.networkAccess) lines.push("(deny network*)");
  }
  return lines.join("\n") + "\n";
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Returns the argv to execute `command` through the sandbox (or plain shell when unavailable).
 * Uses a non-login shell; `runShell` supplies the login PATH via the environment instead.
 */
export function wrapCommand(command: string, spec: SandboxSpec, shell = process.env.SHELL || "/bin/zsh"): { file: string; args: string[]; sandboxed: boolean } {
  if (spec.mode === "danger-full-access" || !osSandboxAvailable()) {
    return { file: shell, args: ["-c", command], sandboxed: false };
  }
  return { file: "/usr/sbin/sandbox-exec", args: ["-p", seatbeltProfile(spec), shell, "-c", command], sandboxed: true };
}

/** Heuristic: did this command fail because the sandbox blocked it? */
export function looksLikeSandboxDenial(stderr: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  return /operation not permitted|read-only file system|sandbox|EPERM|EROFS|Permission denied/i.test(stderr);
}
