import { useEffect, useRef, useState } from "react";
import type { BackendId, Mode, ModelInfo } from "../../shared/types";
import { BACKENDS, MODES } from "../../shared/types";
import { ModelMenu } from "./ModelMenu";

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
          <ModelMenu models={models} model={model} effort={effort} error={modelsError} disabled={busy} onModel={onModel} onEffort={onEffort} />
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
