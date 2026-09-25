import { useEffect, useState } from "react";
import type { BackendId, Mode, ModelInfo, Settings } from "../../shared/types";
import { BACKENDS, MODES } from "../../shared/types";
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

  useEffect(() => {
    void bridge.invoke("backends:health", undefined).then(setHealth).catch(() => setHealth(null));
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
