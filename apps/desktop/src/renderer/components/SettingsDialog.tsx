import { useEffect, useState } from "react";
import type { BackendId, EffortLevel, Mode, ModelInfo, RoutingPolicy, RoutingStatus, RoutingTest, Settings } from "../../shared/types";
import { BACKENDS, EFFORT_LEVELS, MODES } from "../../shared/types";
import { bridge } from "../bridge";

interface Props {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

export function SettingsDialog({ settings, onSave, onClose }: Props) {
  const [s, setS] = useState<Settings>(settings);
  const [health, setHealth] = useState<Record<BackendId, { ok: boolean; detail: string }> | null>(null);
  const [lists, setLists] = useState<Partial<Record<BackendId, { models: ModelInfo[]; error?: string }>>>({});
  const [routing, setRouting] = useState<RoutingStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [test, setTest] = useState<RoutingTest | "running" | null>(null);

  useEffect(() => {
    void bridge.invoke("backends:health", undefined).then(setHealth).catch(() => setHealth(null));
    void bridge.invoke("routing:status", undefined).then(setRouting).catch(() => setRouting(null));
    for (const b of ["codex", "claude"] as BackendId[]) void bridge.invoke("models:list", { backend: b }).then((r) => setLists((l) => ({ ...l, [b]: r }))).catch((err) => setLists((l) => ({ ...l, [b]: { models: [], error: (err as Error).message } })));
  }, []);

  const modelSelect = (b: "claude" | "codex") => {
    const r = lists[b];
    const list = r?.models ?? [];
    return (
      <select value={list.some((m) => m.id === s.default_model[b]) ? s.default_model[b] : ""} onChange={(e) => set("default_model", { ...s.default_model, [b]: e.target.value })} disabled={!list.length}>
        <option value="">{r?.error ? "CLI unavailable" : list.length ? "CLI default" : "Loading…"}</option>
        {list.map((m) => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? " · default" : ""}</option>)}
      </select>
    );
  };

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));
  const setR = <K extends keyof RoutingPolicy>(k: K, v: RoutingPolicy[K]) => setS((x) => ({ ...x, routing: { ...x.routing, [k]: v } }));
  const r = s.routing;
  const learned = routing ? Object.entries(routing.fit.tasks).filter(([, t]) => t.offset !== 0) : [];
  const sourceLabel: Record<RoutingStatus["keySource"], string> = { modex: "Modex keychain", env: "TYPESAFE_API_KEY in the environment", "jev-config": "the jev CLI config (~/.config/jev/config.json)", "login-shell": "your login shell", none: "nowhere" };
  const keyAction = async (fn: () => Promise<RoutingStatus>) => {
    setKeyBusy(true);
    setKeyError(null);
    setTest(null);
    try {
      setRouting(await fn());
      setKeyDraft("");
    } catch (err) {
      setKeyError((err as Error).message);
    } finally {
      setKeyBusy(false);
    }
  };
  const runTest = async () => {
    setTest("running");
    try {
      setTest(await bridge.invoke("routing:test", undefined));
    } catch (err) {
      setTest({ ok: false, message: (err as Error).message, transport: "none", ms: 0 });
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings" data-testid="settings">
        <h2>Settings</h2>
        <p className="hint" style={{ margin: "0 0 12px" }}>Modex drives the Claude Code and Codex CLIs on this machine and never calls a model API for a coding turn — log in with <code>claude</code> and <code>codex login</code>. The only credential it can hold is an optional TypeSafe key for Auto routing, kept in the OS keychain.</p>
        <label className="field">
          <span>Default backend for new threads</span>
          <select value={s.default_backend} onChange={(e) => set("default_backend", e.target.value as BackendId)}>
            {BACKENDS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            <option value="mock">Mock (offline demo)</option>
          </select>
        </label>
        <label className="field">
          <span>Default mode for new threads</span>
          <select value={s.default_mode} onChange={(e) => set("default_mode", e.target.value as Mode)}>
            {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <div className="grid2">
          <label className="field">
            <span>Claude executable</span>
            <input value={s.claude_bin} onChange={(e) => set("claude_bin", e.target.value)} spellCheck={false} />
            <small className={health?.claude.ok ? "ok" : "warn"}>{health ? (health.claude.ok ? `ready · ${health.claude.detail}` : health.claude.detail) : "checking…"}</small>
          </label>
          <label className="field">
            <span>Codex executable</span>
            <input value={s.codex_bin} onChange={(e) => set("codex_bin", e.target.value)} spellCheck={false} />
            <small className={health?.codex.ok ? "ok" : "warn"}>{health ? (health.codex.ok ? `ready · ${health.codex.detail}` : health.codex.detail) : "checking…"}</small>
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Default Claude model</span>
            {modelSelect("claude")}
          </label>
          <label className="field">
            <span>Default Codex model</span>
            {modelSelect("codex")}
          </label>
        </div>
        <h3 className="section-title">Auto routing</h3>
        <p className="routing-status" data-testid="routing-status">
          {routing === null ? "Checking the judge…" : routing.live ? (
            <span className="ok">
              Jev configured — {routing.transport.kind === "cli" ? `via the jev CLI ${routing.transport.version ?? ""} (${routing.transport.bin})` : "via Modex's own HTTPS call"}
              {routing.keyLast4 ? `, key ****${routing.keyLast4} from ${sourceLabel[routing.keySource]}` : routing.keySource === "none" ? ", key left to the CLI" : ""}
              {routing.keyRef ? ` (1Password ${routing.keyRef})` : ""}.
            </span>
          ) : (
            <span className="warn">{routing.detail ?? "Jev is not available."} Auto uses the built-in heuristic.</span>
          )}
          {routing ? ` ${routing.fit.routes} auto turn${routing.fit.routes === 1 ? "" : "s"} so far` : ""}
          {routing && r.premium_turns_per_day != null ? ` · ${routing.fit.premiumToday}/${r.premium_turns_per_day} premium today` : ""}
          {learned.length ? ` · learned: ${learned.map(([k, t]) => `${k.replace(/_/g, " ")} ${t.offset > 0 ? "+" : ""}${t.offset}`).join(", ")}` : ""}
          {routing && routing.fit.routes > 0 ? <> · <button className="btn small ghost" onClick={() => void bridge.invoke("routing:reset", undefined).then(setRouting)}>Reset learning</button></> : null}
        </p>
        <div className="key-row" data-testid="jev-key">
          <label className="field grow">
            <span>TypeSafe API key {routing?.secrets.present ? <em className="ok">· saved in {routing.secrets.backend}{routing.keySource === "modex" && routing.keyLast4 ? ` (****${routing.keyLast4})` : ""}</em> : null}</span>
            <input type="password" autoComplete="off" value={keyDraft} placeholder={routing?.secrets.present ? "Saved — paste a new key to replace it" : "sk-… or op://Vault/Item/field"} onChange={(e) => setKeyDraft(e.target.value)} disabled={keyBusy || routing?.secrets.available === false} spellCheck={false} />
            <small className={routing?.secrets.available === false ? "warn" : ""}>
              {routing?.secrets.available === false
                ? `${routing.secrets.backend} encryption is unavailable here — use TYPESAFE_API_KEY or \`jev config set apiKey …\` instead.`
                : "Encrypted with the OS keychain and kept out of state.json and every build. A 1Password reference is expanded in memory at use time. Env, the jev CLI config, and your login shell are also checked, in that order after this."}
            </small>
            {keyError && <small className="warn">{keyError}</small>}
          </label>
          <div className="key-actions">
            <button className="btn small primary" disabled={keyBusy || !keyDraft.trim()} onClick={() => void keyAction(() => bridge.invoke("routing:setKey", { key: keyDraft }))}>Save key</button>
            <button className="btn small" disabled={keyBusy || !routing?.secrets.present} onClick={() => void keyAction(() => bridge.invoke("routing:clearKey", undefined))}>Clear</button>
            <button className="btn small" disabled={keyBusy || test === "running"} onClick={() => void runTest()} title="Sends one tiny question through the active transport">Test judge</button>
          </div>
        </div>
        {test && test !== "running" && <p className={`routing-test ${test.ok ? "ok" : "warn"}`} data-testid="routing-test">{test.ok ? "✓ " : "✗ "}{test.message}{test.status ? ` (HTTP ${test.status})` : ""} · {test.ms} ms</p>}
        {test === "running" && <p className="routing-test">Asking Jev…</p>}
        <div className="grid2">
          <label className="field">
            <span>Judge transport</span>
            <select value={r.jev_transport} onChange={(e) => setR("jev_transport", e.target.value as RoutingPolicy["jev_transport"])}>
              <option value="auto">Auto — jev CLI when installed, else HTTPS</option>
              <option value="cli">Always the jev CLI</option>
              <option value="http">Always Modex's HTTPS call</option>
            </select>
          </label>
          <label className="field">
            <span>jev executable</span>
            <input value={r.jev_bin} onChange={(e) => setR("jev_bin", e.target.value)} spellCheck={false} />
            <small>{routing?.transport.kind === "cli" ? `found: ${routing.transport.bin} ${routing.transport.version ?? ""}` : "not found on PATH — npm link in TypeSafeAI/cli to install"}</small>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={r.auto_by_default} onChange={(e) => setR("auto_by_default", e.target.checked)} />
          <span>New threads start with Auto on</span>
        </label>
        <div className="grid2">
          <label className="field">
            <span>Posture</span>
            <select data-testid="routing-posture" value={r.posture} onChange={(e) => setR("posture", e.target.value as RoutingPolicy["posture"])}>
              <option value="economy">Economy — one tier down</option>
              <option value="balanced">Balanced</option>
              <option value="quality">Quality — one tier up</option>
            </select>
          </label>
          <label className="field">
            <span>Reasoning effort ceiling</span>
            <select value={r.max_effort} onChange={(e) => setR("max_effort", e.target.value as EffortLevel)}>
              {EFFORT_LEVELS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Minimum judge confidence (below it, Auto keeps your model)</span>
            <input type="number" min={0} max={1} step={0.05} value={r.min_confidence} onChange={(e) => setR("min_confidence", Math.max(0, Math.min(1, Number(e.target.value) || 0)))} />
          </label>
          <label className="field">
            <span>Premium turns per day (top tier / xhigh+; blank = unlimited)</span>
            <input type="number" min={0} step={1} value={r.premium_turns_per_day ?? ""} placeholder="unlimited" onChange={(e) => setR("premium_turns_per_day", e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={r.allow_fast} onChange={(e) => setR("allow_fast", e.target.checked)} />
          <span>Allow fast mode for light, speed-sensitive turns</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={r.allow_backend_switch} onChange={(e) => setR("allow_backend_switch", e.target.checked)} />
          <span>Allow Auto to switch between Codex and Claude when a thread has no session to lose</span>
        </label>
        <label className="field">
          <span>Mock script (offline demo only)</span>
          <input value={s.mock_script ?? ""} onChange={(e) => set("mock_script", e.target.value)} placeholder="/path/to/mock-script.json" spellCheck={false} />
        </label>
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => { onSave(s); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
