import { useEffect, useState } from "react";
import type { Mode, Settings } from "../../shared/types";
import { MODES, MODELS } from "../../shared/types";
import { bridge } from "../bridge";

interface Props {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

export function SettingsDialog({ settings, onSave, onClose }: Props) {
  const [s, setS] = useState<Settings>(settings);
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  useEffect(() => {
    if (s.provider !== "openai") return setHasKey(null);
    void bridge.invoke("env:has", { name: s.api_key_env }).then(setHasKey).catch(() => setHasKey(null));
  }, [s.api_key_env, s.provider]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <label className="field">
          <span>Provider</span>
          <select value={s.provider} onChange={(e) => set("provider", e.target.value as Settings["provider"])}>
            <option value="openai">OpenAI-compatible API</option>
            <option value="mock">Mock (scripted, offline)</option>
          </select>
        </label>
        {s.provider === "openai" ? (
          <>
            <label className="field">
              <span>Base URL</span>
              <input value={s.base_url} onChange={(e) => set("base_url", e.target.value)} placeholder="https://api.openai.com/v1 or http://localhost:11434/v1" spellCheck={false} />
            </label>
            <label className="field">
              <span>API key environment variable</span>
              <input value={s.api_key_env} onChange={(e) => set("api_key_env", e.target.value)} spellCheck={false} />
              <small className={hasKey ? "ok" : "warn"}>
                {hasKey === null ? "" : hasKey ? `${s.api_key_env} is set in Modex's environment.` : `${s.api_key_env} is not set. Launch Modex from a shell where it is exported; keys are never stored by Modex.`}
              </small>
            </label>
          </>
        ) : (
          <label className="field">
            <span>Mock script (JSON)</span>
            <input value={s.mock_script ?? ""} onChange={(e) => set("mock_script", e.target.value)} placeholder="/path/to/mock-script.json" spellCheck={false} />
          </label>
        )}
        <label className="field">
          <span>Default model</span>
          <input value={s.default_model} onChange={(e) => set("default_model", e.target.value)} list="models" spellCheck={false} />
          <datalist id="models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <label className="field">
          <span>Default mode for new threads</span>
          <select value={s.default_mode} onChange={(e) => set("default_mode", e.target.value as Mode)}>
            {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => { onSave(s); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
