import { useEffect, useRef, useState } from "react";
import type { Mode } from "../../shared/types";

interface Props {
  busy: boolean;
  mode: Mode;
  model: string;
  modes: { id: Mode; label: string; hint: string }[];
  models: string[];
  onMode: (m: Mode) => void;
  onModel: (m: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ busy, mode, model, modes, models, onMode, onModel, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const modeInfo = modes.find((m) => m.id === mode);

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
      <div className="composer-box">
        <textarea
          ref={ta}
          value={text}
          placeholder={busy ? "Modex is working… (you can stop it)" : "Describe a task, ask a question, or paste an error…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={false}
          spellCheck={false}
        />
        <div className="composer-bar">
          <label className="select" title={modeInfo?.hint}>
            <select value={mode} onChange={(e) => onMode(e.target.value as Mode)}>
              {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <input className="model-input" list="composer-models" value={model} onChange={(e) => onModel(e.target.value)} title="Model id — pick one or type any OpenAI-compatible model name" spellCheck={false} />
          <datalist id="composer-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          <span className="spacer" />
          <span className="kbd-hint">{modeInfo?.hint}</span>
          {busy ? (
            <button className="btn danger" onClick={onStop}>■ Stop</button>
          ) : (
            <button className="btn primary send" onClick={submit} disabled={!text.trim()}>Send ↵</button>
          )}
        </div>
      </div>
    </div>
  );
}
