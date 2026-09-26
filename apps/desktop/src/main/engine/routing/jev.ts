import { execFile } from "node:child_process";

/**
 * Minimal TypeSafe System One client for the routing judge.
 *
 * Jev is not a coding model and never runs a turn: it answers a handful of typed questions
 * about the *request* (what kind of task, how complex, how risky, does speed matter) and code
 * turns those judgments into a model/effort/fast-mode choice. Coding turns still run only
 * through the `claude` and `codex` CLIs.
 *
 * Wire format (https://docs.typesafe.ai/api):
 *   POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer <key>
 *   { state, model, questions: { id: { type: "choice"|"score"|"noul", instructions, criteria } } }
 *   → { model, answers: { id: { type, choice|score|noul, probabilities?, confidence? } }, usage }
 */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const KEY_ENV = "TYPESAFE_API_KEY";

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

/** Anything that answers a Jev request: the HTTP client, or a fake in tests. */
export type JevTransport = (req: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;

export type JevErrorCode = "auth" | "billing" | "validation" | "rate_limited" | "overloaded" | "timeout" | "network" | "bad_response" | "unknown";

export class JevError extends Error {
  constructor(message: string, readonly code: JevErrorCode, readonly status?: number) {
    super(message);
    this.name = "JevError";
  }
}

export function describeHttpError(status: number): JevError {
  switch (status) {
    case 401:
    case 403: return new JevError("TypeSafe rejected the API key.", "auth", status);
    case 402: return new JevError("The TypeSafe organization has no API credits.", "billing", status);
    case 400:
    case 422: return new JevError("TypeSafe rejected the routing request as invalid.", "validation", status);
    case 429: return new JevError("TypeSafe rate limit hit.", "rate_limited", status);
    case 503:
    case 529: return new JevError("TypeSafe is overloaded.", "overloaded", status);
    default: return new JevError(`TypeSafe API returned HTTP ${status}.`, "unknown", status);
  }
}

/** The real transport. `timeoutMs` bounds how long a turn waits on the judge before falling back. */
export function httpTransport(apiKey: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; endpoint?: string } = {}): JevTransport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const endpoint = opts.endpoint ?? JEV_ENDPOINT;
  return async (req, signal) => {
    const ac = new AbortController();
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
    if (!res.ok) throw describeHttpError(res.status);
    try {
      const body = JSON.parse(text) as JevResponse;
      if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") throw new Error("no answers");
      return body;
    } catch {
      throw new JevError("TypeSafe returned a response Modex could not read.", "bad_response", res.status);
    }
  };
}

export type KeySource = "env" | "login-shell" | "none";

let loginKeyPromise: Promise<string | null> | null = null;

/**
 * Finds the TypeSafe key without storing it: the process environment first, then — because a
 * Finder-launched Electron app inherits no shell profile — the user's login shell, once.
 * Set MODEX_NO_LOGIN_PATH=1 to skip the shell lookup (tests, CI).
 */
export async function resolveTypesafeKey(env: NodeJS.ProcessEnv = process.env): Promise<{ key: string | null; source: KeySource }> {
  const direct = env[KEY_ENV]?.trim();
  if (direct) return { key: direct, source: "env" };
  if (env.MODEX_NO_LOGIN_PATH) return { key: null, source: "none" };
  loginKeyPromise ??= new Promise((resolve) => {
    execFile(env.SHELL || "/bin/zsh", ["-lc", `printf "%s" "$${KEY_ENV}"`], { timeout: 10_000, env }, (err, stdout) => resolve(!err && stdout.trim() ? stdout.trim() : null));
  });
  const key = await loginKeyPromise;
  return key ? { key, source: "login-shell" } : { key: null, source: "none" };
}

/** Tests reset the cached login-shell lookup. */
export function resetKeyCache(): void {
  loginKeyPromise = null;
}
