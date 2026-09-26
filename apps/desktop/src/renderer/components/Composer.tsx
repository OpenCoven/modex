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
  auto: boolean;
  models: ModelInfo[];
  modelsError?: string;
  onBackend: (b: BackendId) => void;
  onMode: (m: Mode) => void;
  onPlan: (plan: boolean) => void;
  onModel: (m: string) => void;
  onEffort: (e: string | undefined) => void;
  onAuto: (auto: boolean) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Set by the ⌘⏎ / focus shortcuts in App. */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function Composer({ busy, backend, mode, plan, model, effort, auto, models, modelsError, onBackend, onMode, onPlan, onModel, onEffort, onAuto, onSend, onStop, inputRef }: Props) {
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
    <div className="composer" data-testid="composer">
      <div className={`composer-box ${plan ? "plan" : ""}`} data-testid="composer-box">
        <textarea
          ref={ta}
          data-testid="composer-input"
          aria-label="Message"
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
          <div className="segmented" role="radiogroup" aria-label="Backend" data-testid="backend-picker">
            {BACKENDS.map((b) => (
              <button key={b.id} role="radio" aria-checked={backend === b.id} className={backend === b.id ? "on" : ""} title={b.hint} onClick={() => onBackend(b.id)} disabled={busy}>
                {b.label}
              </button>
            ))}
            {backend === "mock" && <button role="radio" aria-checked className="on" title="Offline scripted engine (demo)">Mock</button>}
          </div>
          <label className="select" title={modeInfo?.hint}>
            <select data-testid="mode-picker" aria-label="Mode" value={mode} onChange={(e) => onMode(e.target.value as Mode)} disabled={busy}>
              {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <button className={`btn small toggle ${plan ? "on" : ""}`} onClick={() => onPlan(!plan)} disabled={busy} data-testid="plan-toggle" aria-pressed={plan} title="Plan mode: investigate read-only and return a plan instead of editing (⇧⌘P)">
            ▤ Plan
          </button>
          <button className={`btn small toggle auto ${auto ? "on" : ""}`} onClick={() => onAuto(!auto)} disabled={busy} aria-pressed={auto} data-testid="auto-toggle" title="Auto: before each turn a fast judge (Jev, or a built-in heuristic without a key) reads your request and picks the model, reasoning effort, and fast mode within your limits. Pick a model by hand any time — Auto learns from it.">
            ⚡ Auto
          </button>
          <ModelMenu models={models} model={model} effort={effort} error={modelsError} disabled={busy} onModel={onModel} onEffort={onEffort} />
          <span className="spacer" />
          {busy ? (
            <button className="btn danger" onClick={onStop} data-testid="stop">■ Stop</button>
          ) : (
            <button className="btn primary send" data-testid="send" onClick={submit} disabled={!text.trim()}>Send <kbd>⌘⏎</kbd></button>
          )}
        </div>
        {modelsError && <div className="composer-warn">⚠ {modelsError}</div>}
      </div>
    </div>
  );
}
