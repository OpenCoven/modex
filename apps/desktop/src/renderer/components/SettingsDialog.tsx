import { useEffect, useState } from "react";
import type { BackendId, EffortLevel, Mode, ModelInfo, RoutingPolicy, RoutingStatus, Settings } from "../../shared/types";
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <p className="hint" style={{ margin: "0 0 12px" }}>Modex drives the Claude Code and Codex CLIs on this machine. It never calls a model API directly and never stores credentials — log in with <code>claude</code> and <code>codex login</code>.</p>
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
          {routing === null ? "Checking the judge…" : routing.live ? <span className="ok">Jev is live ({routing.model}, key from {routing.keySource === "env" ? "the environment" : "your login shell"}).</span> : <span className="warn">{routing.detail ?? "Jev is not available."} Auto uses the built-in heuristic{routing.keySource === "none" ? " — export TYPESAFE_API_KEY in your shell profile to route with Jev" : ""}.</span>}
          {routing ? ` ${routing.fit.routes} auto turn${routing.fit.routes === 1 ? "" : "s"} so far` : ""}
          {routing && r.premium_turns_per_day != null ? ` · ${routing.fit.premiumToday}/${r.premium_turns_per_day} premium today` : ""}
          {learned.length ? ` · learned: ${learned.map(([k, t]) => `${k.replace(/_/g, " ")} ${t.offset > 0 ? "+" : ""}${t.offset}`).join(", ")}` : ""}
          {routing && routing.fit.routes > 0 ? <> · <button className="btn small ghost" onClick={() => void bridge.invoke("routing:reset", undefined).then(setRouting)}>Reset learning</button></> : null}
        </p>
        <label className="check">
          <input type="checkbox" checked={r.auto_by_default} onChange={(e) => setR("auto_by_default", e.target.checked)} />
          <span>New threads start with Auto on</span>
        </label>
        <div className="grid2">
          <label className="field">
            <span>Posture</span>
            <select value={r.posture} onChange={(e) => setR("posture", e.target.value as RoutingPolicy["posture"])}>
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
