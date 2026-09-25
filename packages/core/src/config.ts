import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalPolicy, ModexConfig, SandboxMode } from "./types.js";

export const APPROVAL_POLICIES: ApprovalPolicy[] = ["untrusted", "on-request", "never"];
export const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

export function modexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MODEX_HOME ?? path.join(os.homedir(), ".modex");
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): ModexConfig {
  return {
    model: "gpt-5-codex",
    provider: { name: "openai", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" },
    approval_policy: "on-request",
    sandbox_mode: "workspace-write",
    network_access: false,
    writable_roots: [],
    max_turns: 40,
    shell_timeout_ms: 120_000,
    home: modexHome(env),
  };
}

/** Deep-ish merge for the flat-with-one-nested-object config shape. */
export function mergeConfig(base: ModexConfig, patch: Partial<Record<string, unknown>>): ModexConfig {
  const out: ModexConfig = { ...base, provider: { ...base.provider }, writable_roots: [...base.writable_roots] };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    switch (key) {
      case "provider":
        if (value && typeof value === "object") Object.assign(out.provider, value as Record<string, unknown>);
        break;
      case "approval_policy":
        if (APPROVAL_POLICIES.includes(value as ApprovalPolicy)) out.approval_policy = value as ApprovalPolicy;
        else throw new Error(`invalid approval_policy: ${String(value)} (expected ${APPROVAL_POLICIES.join("|")})`);
        break;
      case "sandbox_mode":
        if (SANDBOX_MODES.includes(value as SandboxMode)) out.sandbox_mode = value as SandboxMode;
        else throw new Error(`invalid sandbox_mode: ${String(value)} (expected ${SANDBOX_MODES.join("|")})`);
        break;
      case "writable_roots":
        if (Array.isArray(value)) out.writable_roots = value.map(String);
        break;
      case "max_turns":
      case "shell_timeout_ms":
        out[key] = Number(value);
        break;
      case "network_access":
        out.network_access = value === true || value === "true";
        break;
      case "model":
      case "mock_script":
      case "home":
        out[key] = String(value);
        break;
      default:
        // Unknown keys are ignored so older configs keep working.
        break;
    }
  }
  return out;
}

/** Reads ~/.modex/config.json (if present) on top of defaults, then env overrides. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ModexConfig {
  let cfg = defaultConfig(env);
  const file = path.join(cfg.home, "config.json");
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    cfg = mergeConfig(cfg, raw);
  }
  if (env.MODEX_MODEL) cfg = mergeConfig(cfg, { model: env.MODEX_MODEL });
  if (env.MODEX_BASE_URL) cfg = mergeConfig(cfg, { provider: { base_url: env.MODEX_BASE_URL } });
  if (env.MODEX_PROVIDER) cfg = mergeConfig(cfg, { provider: { name: env.MODEX_PROVIDER } });
  if (env.MODEX_MOCK_SCRIPT) cfg = mergeConfig(cfg, { mock_script: env.MODEX_MOCK_SCRIPT, provider: { name: "mock" } });
  return cfg;
}

/** Applies `-c key=value` overrides. Values parse as JSON when possible, else raw strings. */
export function applyOverrides(cfg: ModexConfig, overrides: string[]): ModexConfig {
  const patch: Record<string, unknown> = {};
  for (const o of overrides) {
    const eq = o.indexOf("=");
    if (eq < 0) throw new Error(`bad -c override (expected key=value): ${o}`);
    const key = o.slice(0, eq).trim();
    const rawValue = o.slice(eq + 1);
    let value: unknown = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      /* raw string */
    }
    const dot = key.indexOf(".");
    if (dot >= 0) {
      const head = key.slice(0, dot);
      const tail = key.slice(dot + 1);
      const nested = (patch[head] as Record<string, unknown> | undefined) ?? {};
      nested[tail] = value;
      patch[head] = nested;
    } else {
      patch[key] = value;
    }
  }
  return mergeConfig(cfg, patch);
}

export function resolveApiKey(cfg: ModexConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MODEX_API_KEY ?? env[cfg.provider.api_key_env];
}
