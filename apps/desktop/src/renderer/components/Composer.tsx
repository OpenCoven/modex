import { useEffect, useRef, useState } from "react";
import type { BackendId, Mode, ModelInfo } from "../../shared/types";
import { BACKENDS, MODES } from "../../shared/types";

interface Props {
  busy: boolean;
  backend: BackendId;
  mode: Mode;
  plan: boolean;
  model: string;
  effort?: string;
  models: ModelInfo[];
  modelsError?: string;
  onBackend: (b: BackendId) => void;
  onMode: (m: Mode) => void;
  onPlan: (plan: boolean) => void;
  onModel: (m: string) => void;
  onEffort: (e: string | undefined) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Set by the ⌘⏎ / focus shortcuts in App. */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function Composer({ busy, backend, mode, plan, model, effort, models, modelsError, onBackend, onMode, onPlan, onModel, onEffort, onSend, onStop, inputRef }: Props) {
  const [text, setText] = useState("");
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const ta = inputRef ?? fallbackRef;
  const modeInfo = MODES.find((m) => m.id === mode);
  const selected = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault);
  const efforts = selected?.efforts ?? [];

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(220, Math.max(44, el.scrollHeight))}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="composer">
      <div className={`composer-box ${plan ? "plan" : ""}`}>
        <textarea
          ref={ta}
          value={text}
          placeholder={busy ? "Working… (⌘. or Stop to interrupt)" : plan ? "Describe what you want planned — nothing will be edited." : "Describe a task, ask a question, or paste an error…  (⏎ or ⌘⏎ to send)"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              submit();
            }
          }}
          spellCheck={false}
        />
        <div className="composer-bar">
          <div className="segmented" role="radiogroup" aria-label="Backend">
            {BACKENDS.map((b) => (
              <button key={b.id} role="radio" aria-checked={backend === b.id} className={backend === b.id ? "on" : ""} title={b.hint} onClick={() => onBackend(b.id)} disabled={busy}>
                {b.label}
              </button>
            ))}
            {backend === "mock" && <button role="radio" aria-checked className="on" title="Offline scripted engine (demo)">Mock</button>}
          </div>
          <label className="select" title={modeInfo?.hint}>
            <select value={mode} onChange={(e) => onMode(e.target.value as Mode)} disabled={busy}>
              {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <button className={`btn small toggle ${plan ? "on" : ""}`} onClick={() => onPlan(!plan)} disabled={busy} title="Plan mode: investigate read-only and return a plan instead of editing (⇧⌘P)">
            ▤ Plan
          </button>
          <label className="select" title={modelsError ? `Could not load models: ${modelsError}` : selected?.description ?? "Model"}>
            <select value={models.some((m) => m.id === model) ? model : model ? "__custom" : ""} onChange={(e) => e.target.value !== "__custom" && onModel(e.target.value)} disabled={busy}>
              <option value="">{backend === "claude" ? "CLI default model" : backend === "codex" ? "CLI default model" : "mock"}</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? " · default" : ""}</option>)}
              {model && !models.some((m) => m.id === model) && <option value="__custom">{model}</option>}
            </select>
          </label>
          <input className="model-input" value={model} onChange={(e) => onModel(e.target.value)} placeholder="model id" title="Type any model id the CLI accepts" spellCheck={false} disabled={busy} />
          {efforts.length > 0 && (
            <label className="select" title="Reasoning effort">
              <select value={effort ?? ""} onChange={(e) => onEffort(e.target.value || undefined)} disabled={busy}>
                <option value="">effort: default{selected?.defaultEffort ? ` (${selected.defaultEffort})` : ""}</option>
                {efforts.map((e) => <option key={e} value={e}>effort: {e}</option>)}
              </select>
            </label>
          )}
          <span className="spacer" />
          {busy ? (
            <button className="btn danger" onClick={onStop}>■ Stop</button>
          ) : (
            <button className="btn primary send" onClick={submit} disabled={!text.trim()}>Send <kbd>⌘⏎</kbd></button>
          )}
        </div>
        {modelsError && <div className="composer-warn">⚠ {modelsError}</div>}
      </div>
    </div>
  );
}
