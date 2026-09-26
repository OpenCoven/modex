import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Minimal TypeSafe System One client for the routing judge, plus the two ways Modex can reach
 * Jev: its own HTTPS call, or the `jev` CLI (https://github.com/TypeSafeAI/cli) when installed.
 *
 * Jev is not a coding model and never runs a turn: it answers a handful of typed questions
 * about the *request* and code turns those judgments into a model/effort/fast-mode choice.
 * Coding turns still run only through the `claude` and `codex` CLIs.
 *
 * Wire format (https://docs.typesafe.ai/api):
 *   POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer <key>
 *   { state, model, questions: { id: { type: "choice"|"score"|"noul", instructions, criteria } } }
 *   → { model, answers: { id: { type, choice|score|noul, probabilities?, confidence? } }, usage }
 */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const KEY_ENV = "TYPESAFE_API_KEY";
export const ALT_KEY_ENV = "JEV_API_KEY";

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number; legend?: Record<string, string> }
  | { type: "noul"; noul: number };

export interface JevRequest {
  state: unknown;
  model: string;
  questions: Record<string, JevQuestion>;
}

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anything that answers a Jev request: the HTTP client, the CLI, or a fake in tests. */
export type JevTransport = (req: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;

export type JevErrorCode = "auth" | "billing" | "validation" | "rate_limited" | "overloaded" | "timeout" | "network" | "bad_response" | "unknown";

export class JevError extends Error {
  constructor(message: string, readonly code: JevErrorCode, readonly status?: number) {
    super(message);
    this.name = "JevError";
  }
}

/** TypeSafe puts the actionable sentence in `detail.message` (billing links, validation reasons). */
export function upstreamDetail(raw: string): string {
  try {
    const body = JSON.parse(raw) as { detail?: unknown; error?: unknown };
    const detail = body?.detail ?? body?.error ?? body;
    const message = typeof detail === "string" ? detail : (detail as { message?: unknown })?.message;
    return typeof message === "string" ? message.trim() : "";
  } catch {
    return "";
  }
}

export function describeHttpError(status: number, raw = ""): JevError {
  const detail = upstreamDetail(raw);
  const mk = (msg: string, code: JevErrorCode) => new JevError(detail || msg, code, status);
  switch (status) {
    case 401:
    case 403: return mk("TypeSafe rejected the API key.", "auth");
    case 402: return mk("The TypeSafe organization has no API credits.", "billing");
    case 400:
    case 422: return mk("TypeSafe rejected the routing request as invalid.", "validation");
    case 429: return mk("TypeSafe rate limit hit.", "rate_limited");
    case 503:
    case 529: return mk("TypeSafe is overloaded.", "overloaded");
    default: return mk(`TypeSafe API returned HTTP ${status}.`, "unknown");
  }
}

// ---------------------------------------------------------------------------
// Transport 1: in-process HTTPS
// ---------------------------------------------------------------------------

export function httpTransport(apiKey: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; endpoint?: string } = {}): JevTransport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const endpoint = opts.endpoint ?? JEV_ENDPOINT;
  return async (req, signal) => {
    const ac = new AbortController();
    if (signal?.aborted) ac.abort();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onOuter = () => ac.abort();
    signal?.addEventListener("abort", onOuter, { once: true });
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: ac.signal,
      });
    } catch (err) {
      const abort = err instanceof Error && err.name === "AbortError";
      throw new JevError(abort ? "The routing request to TypeSafe timed out." : "Could not reach the TypeSafe API.", abort ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuter);
    }
    const text = await res.text();
    if (!res.ok) throw describeHttpError(res.status, text);
    return parseResponse(text, res.status);
  };
}

function parseResponse(text: string, status?: number): JevResponse {
  try {
    const body = JSON.parse(text) as JevResponse;
    if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") throw new Error("no answers");
    return body;
  } catch {
    throw new JevError("TypeSafe returned a response Modex could not read.", "bad_response", status);
  }
}

// ---------------------------------------------------------------------------
// Transport 2: the `jev` CLI (`jev run - --raw`), sharing its config, retries, and doctor.
// ---------------------------------------------------------------------------

export interface CliInfo {
  bin: string;
  version: string;
}

export type SpawnLike = (file: string, args: string[], opts: { env?: NodeJS.ProcessEnv; stdio?: unknown }) => ChildProcess;

/** `jev version --json` → { bin, version }, or null when the CLI is not on PATH / not this CLI. */
export function detectJevCli(bin = "jev", env: NodeJS.ProcessEnv = process.env, timeoutMs = 4000): Promise<CliInfo | null> {
  return new Promise((resolve) => {
    execFile(bin, ["version", "--json"], { env, timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const v = JSON.parse(String(stdout)) as { name?: string; version?: string };
        resolve(v.name === "jev" && typeof v.version === "string" ? { bin, version: v.version } : null);
      } catch {
        // 0.1.x printed "jev 0.1.0" without --json support; still usable for `run`.
        const m = /^jev (\S+)/.exec(String(stdout).trim());
        resolve(m ? { bin, version: m[1]! } : null);
      }
    });
  });
}

/** Parses the CLI's stderr — JSON under JEV_OUTPUT=json, or `error: <msg> (HTTP nnn)` — into a JevError. */
export function cliError(stderr: string, exitCode: number | null): JevError {
  const text = stderr.trim();
  // The CLI prints one JSON object (pretty or compact) under JEV_OUTPUT=json; try the whole text, then the last line.
  for (const candidate of [text, text.split("\n").filter(Boolean).at(-1) ?? ""]) {
    try {
      const parsed = JSON.parse(candidate) as { error?: { code?: string; message?: string; status?: number | null } };
      if (parsed?.error?.message) {
        const code = (parsed.error.code === "usage" ? "validation" : parsed.error.code) as JevErrorCode;
        return new JevError(parsed.error.message, code, parsed.error.status ?? undefined);
      }
    } catch {
      /* try the next candidate */
    }
  }
  const m = /error:\s*(.*?)(?:\s*\(HTTP (\d+)\))?\s*$/s.exec(text);
  const status = m?.[2] ? Number(m[2]) : undefined;
  if (status) return describeHttpError(status, "");
  if (exitCode === 3) return new JevError(m?.[1] || "The jev CLI has no usable API key.", "auth");
  return new JevError(m?.[1] || `jev CLI exited with code ${exitCode ?? "?"}`, "unknown");
}

/**
 * Runs `jev run - --raw` with the payload on stdin. The key, when Modex resolved one, travels
 * in the child's environment only; when Modex has none, the CLI's own resolution applies.
 */
export function cliTransport(bin: string, opts: { apiKey?: string | null; env?: NodeJS.ProcessEnv; timeoutMs?: number; spawnImpl?: SpawnLike } = {}): JevTransport {
  const spawnImpl = opts.spawnImpl ?? (spawn as unknown as SpawnLike);
  const timeoutMs = opts.timeoutMs ?? 8000;
  return (req, signal) =>
    new Promise<JevResponse>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), JEV_OUTPUT: "json", JEV_TIMEOUT_MS: String(timeoutMs) };
      if (opts.apiKey) env[KEY_ENV] = opts.apiKey;
      let child: ChildProcess;
      try {
        child = spawnImpl(bin, ["run", "-", "--raw", "--compact", "--attempts", "1"], { env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        return reject(new JevError(`could not start ${bin}: ${(err as Error).message}`, "network"));
      }
      let out = "";
      let errText = "";
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn(); } };
      const timer = setTimeout(() => { child.kill(); done(() => reject(new JevError("The jev CLI did not answer in time.", "timeout"))); }, timeoutMs + 500);
      const onAbort = () => { child.kill(); done(() => reject(new JevError("Routing was cancelled.", "timeout"))); };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => done(() => reject(new JevError(`${bin}: ${err.message}`, "network"))));
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (errText += d.toString()));
      child.on("close", (code) => done(() => {
        if (code === 0) {
          try { resolve(parseResponse(out)); } catch (err) { reject(err); }
        } else reject(cliError(errText, code));
      }));
      child.stdin?.end(JSON.stringify(req));
    });
}

// ---------------------------------------------------------------------------
// Key resolution: Modex's keychain → env → the jev CLI's config → login shell. Any value may
// be a 1Password reference (op://…), expanded in memory via `op read`, never written.
// ---------------------------------------------------------------------------

export type KeySource = "modex" | "env" | "jev-config" | "login-shell" | "none";

export interface ResolvedKey {
  key: string | null;
  source: KeySource;
  /** The op:// reference the key came from, if any. */
  ref?: string;
  /** Why a configured value could not be used (e.g. 1Password locked). */
  problem?: string;
}

export interface KeyResolverOptions {
  env?: NodeJS.ProcessEnv;
  /** Modex's own store; checked first. */
  stored?: () => string | null;
  /** The jev CLI's config file (JEV_CONFIG or ~/.config/jev/config.json). */
  jevConfigPath?: string;
  /** Expands op:// references; defaults to `op read --no-newline`. */
  readRef?: (ref: string) => Promise<string>;
  /** Login-shell lookup for GUI launches; defaults to `$SHELL -lc`. */
  loginShell?: (name: string) => Promise<string | null>;
}

export const isSecretRef = (value: string | null | undefined): value is string => typeof value === "string" && value.trim().startsWith("op://");

export function jevConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.JEV_CONFIG?.trim() || path.join(os.homedir(), ".config", "jev", "config.json");
}

export function readJevConfigKey(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { apiKey?: unknown };
    return typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : null;
  } catch {
    return null;
  }
}

export function readOpRef(ref: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("op", ["read", "--no-newline", ref.trim()], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      if (!err && String(stdout).trim()) return resolve(String(stdout).trim());
      const e = err as (Error & { code?: string }) | null;
      const se = String(stderr ?? "").trim();
      if (e?.code === "ENOENT") return reject(new Error("1Password CLI (`op`) is not installed, so the op:// reference cannot be read."));
      if (/not signed in|no account|authorization/i.test(se)) return reject(new Error("1Password is locked; unlock it (or `eval $(op signin)`) and retry."));
      reject(new Error(`Could not read ${ref.trim()} from 1Password${se ? `: ${se}` : "."}`));
    });
  });
}

let loginShellCache = new Map<string, Promise<string | null>>();

export function loginShellValue(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.MODEX_NO_LOGIN_PATH) return Promise.resolve(null);
  let p = loginShellCache.get(name);
  if (!p) {
    p = new Promise((resolve) => {
      execFile(env.SHELL || "/bin/zsh", ["-lc", `printf "%s" "$${name}"`], { timeout: 10_000, env }, (err, stdout) => resolve(!err && stdout.trim() ? stdout.trim() : null));
    });
    loginShellCache.set(name, p);
  }
  return p;
}

/** Tests reset the cached login-shell lookups. */
export function resetKeyCache(): void {
  loginShellCache = new Map();
}

export async function resolveTypesafeKey(envOrOpts: NodeJS.ProcessEnv | KeyResolverOptions = process.env): Promise<ResolvedKey> {
  const opts: KeyResolverOptions = "env" in envOrOpts || "stored" in envOrOpts || "jevConfigPath" in envOrOpts || "readRef" in envOrOpts || "loginShell" in envOrOpts ? (envOrOpts as KeyResolverOptions) : { env: envOrOpts as NodeJS.ProcessEnv };
  const env = opts.env ?? process.env;
  const readRef = opts.readRef ?? ((ref) => readOpRef(ref, env));
  const candidates: { value: string | null | undefined; source: KeySource }[] = [
    { value: opts.stored?.(), source: "modex" },
    { value: env[KEY_ENV], source: "env" },
    { value: env[ALT_KEY_ENV], source: "env" },
    { value: readJevConfigKey(opts.jevConfigPath ?? jevConfigPath(env)), source: "jev-config" },
  ];
  for (const c of candidates) {
    const value = c.value?.trim();
    if (!value) continue;
    if (!isSecretRef(value)) return { key: value, source: c.source };
    try {
      return { key: await readRef(value), source: c.source, ref: value };
    } catch (err) {
      return { key: null, source: c.source, ref: value, problem: (err as Error).message };
    }
  }
  const shell = await (opts.loginShell ?? ((n) => loginShellValue(n, env)))(KEY_ENV);
  if (shell) {
    if (!isSecretRef(shell)) return { key: shell, source: "login-shell" };
    try {
      return { key: await readRef(shell), source: "login-shell", ref: shell };
    } catch (err) {
      return { key: null, source: "login-shell", ref: shell, problem: (err as Error).message };
    }
  }
  return { key: null, source: "none" };
}
