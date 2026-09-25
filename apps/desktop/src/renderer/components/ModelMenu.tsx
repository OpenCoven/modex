import { useEffect, useRef, useState } from "react";
import type { ModelInfo } from "../../shared/types";

interface Props {
  models: ModelInfo[];
  model: string;
  effort?: string;
  error?: string;
  disabled?: boolean;
  onModel: (id: string) => void;
  onEffort: (effort: string | undefined) => void;
}

/**
 * Codex-App-style model picker: a popover listing exactly the models the CLI reports
 * (name + description, default marked) and, for models that support it, a reasoning-effort
 * row. There is no free-text entry — a model is always one the CLI can run.
 */
export function ModelMenu({ models, model, effort, error, disabled, onModel, onEffort }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = models.find((m) => m.id === model);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = error ? "Models unavailable" : models.length === 0 ? "Loading models…" : selected ? selected.label : "Choose model";
  const effortLabel = selected?.efforts?.length ? ` · ${effort ?? selected.defaultEffort ?? "default"}` : "";

  return (
    <div className="model-menu" ref={ref}>
      <button className={`btn small model-trigger ${error ? "warn" : ""}`} onClick={() => setOpen((v) => !v)} disabled={disabled || (!error && models.length === 0)} title={error ?? selected?.description ?? "Model"} aria-haspopup="listbox" aria-expanded={open}>
        <span className="model-trigger-label">{label}{effortLabel}</span>
        <span className="chev">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="menu" role="listbox" aria-label="Model">
          {error && <div className="menu-error">{error}</div>}
          {models.map((m) => (
            <button key={m.id} role="option" aria-selected={m.id === model} className={`menu-item ${m.id === model ? "selected" : ""}`} onClick={() => { onModel(m.id); onEffort(m.defaultEffort); if (!m.efforts?.length) setOpen(false); }}>
              <span className="menu-check">{m.id === model ? "✓" : ""}</span>
              <span className="menu-body">
                <span className="menu-title">{m.label}{m.isDefault ? <span className="menu-default">default</span> : null}</span>
                {m.description && <span className="menu-desc">{m.description}</span>}
                {m.id === model && m.efforts?.length ? (
                  <span className="effort-row" role="radiogroup" aria-label="Reasoning effort">
                    <span className="effort-label">Reasoning</span>
                    {m.efforts.map((e) => (
                      <span key={e} role="radio" aria-checked={(effort ?? m.defaultEffort) === e} className={`effort-pill ${(effort ?? m.defaultEffort) === e ? "on" : ""}`} onClick={(ev) => { ev.stopPropagation(); onEffort(e); setOpen(false); }}>
                        {e}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
