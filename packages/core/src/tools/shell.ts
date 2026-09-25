import { spawn, execFile } from "node:child_process";
import type { SandboxSpec } from "../sandbox.js";
import { wrapCommand } from "../sandbox.js";

let loginPathPromise: Promise<string | null> | null = null;

/**
 * The user's login-shell PATH, resolved once per process. Commands then run with a fast
 * non-login shell (`-c`) but still see the same tools the user has in a terminal — a login
 * shell with a heavy profile can add seconds to every command otherwise.
 */
export function loginPath(shell = process.env.SHELL || "/bin/zsh"): Promise<string | null> {
  if (process.env.MODEX_NO_LOGIN_PATH) return Promise.resolve(null);
  return (loginPathPromise ??= new Promise((resolve) => {
    execFile(shell, ["-lc", 'printf "%s" "$PATH"'], { timeout: 10_000, env: process.env }, (err, stdout) => {
      resolve(!err && stdout.trim() ? stdout.trim() : null);
    });
  }));
}

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sandboxed: boolean;
  durationMs: number;
}

const MAX_OUTPUT = 16 * 1024;

export async function runShell(command: string, opts: { cwd: string; timeoutMs: number; sandbox: SandboxSpec; env?: NodeJS.ProcessEnv }): Promise<ShellResult> {
  const { file, args, sandboxed } = wrapCommand(command, opts.sandbox);
  const started = Date.now();
  const PATH = (await loginPath()) ?? process.env.PATH;
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: { ...process.env, PATH, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + String(err), timedOut, sandboxed, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr), timedOut, sandboxed, durationMs: Date.now() - started });
    });
  });
}

export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max / 2);
  const tail = s.slice(-max / 2);
  return `${head}\n...[${s.length - max} bytes truncated]...\n${tail}`;
}

export function formatShellResult(r: ShellResult): string {
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  if (r.timedOut) parts.push("[timed out]");
  parts.push(`[exit ${r.exitCode ?? "signal"}${r.sandboxed ? ", sandboxed" : ""}, ${r.durationMs}ms]`);
  return parts.join("\n");
}
