import { useRef, useState } from "react";
import type { ModelInfo } from "../../shared/types";
import { Icon } from "./ui/Icon";
import { Menu, MenuItem } from "./ui/Menu";

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
 * row. There is no free-text entry — a model is always one the CLI can run. Popover behaviour
 * (focus, arrow keys, Escape, outside click) comes from the shared Menu primitive.
 */
export function ModelMenu({ models, model, effort, error, disabled, onModel, onEffort }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = models.find((m) => m.id === model);

  const label = error ? "Models unavailable" : models.length === 0 ? "Loading models…" : selected ? selected.label : "Choose model";
  const effortLabel = selected?.efforts?.length ? (effort ?? selected.defaultEffort ?? "default") : "";

  return (
    <div className="model-menu">
      <button ref={trigger} data-testid="model-picker" className={`model-trigger${error ? " warn" : ""}`} onClick={() => setOpen((v) => !v)} disabled={disabled || (!error && models.length === 0)} title={error ?? selected?.description ?? "Model"} aria-haspopup="listbox" aria-expanded={open}>
        <span className="model-trigger-label">{label}</span>
        {effortLabel && <span className="model-trigger-effort">{effortLabel}</span>}
        <Icon name={open ? "chevron-up" : "chevron-down"} size={12} className="chev" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={trigger} role="listbox" label="Model" testId="model-menu" className="model-list" placement="top-end">
        {error && <div className="menu-error">{error}</div>}
        {models.map((m) => (
          <MenuItem key={m.id} data-testid="model-option" checkable selected={m.id === model} onClick={() => { onModel(m.id); onEffort(m.defaultEffort); if (!m.efforts?.length) setOpen(false); }}>
            <span className="menu-body">
              <span className="menu-title" data-testid="model-option-title">{m.label}{m.isDefault ? <span className="menu-default">default</span> : null}</span>
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
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}
