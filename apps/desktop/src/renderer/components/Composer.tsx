import { useEffect, useRef, useState } from "react";
import type { BackendId, Mode, ModelInfo } from "../../shared/types";
import { BACKENDS, MODES } from "../../shared/types";
import { ModelMenu } from "./ModelMenu";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { Kbd } from "./ui/Kbd";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ui/Menu";

/** Where the thread runs, shown in the strip above the box. */
export interface ComposerContext {
  project: string;
  cwd: string;
  /** Present for worktree threads. */
  worktree?: { branch: string };
  /** The checkout's current branch, when it is a git repository. */
  branch?: string;
  /** Drafts only: Local/Worktree is a choice, made before the thread (and its worktree) exists. */
  onToggleWorktree?: () => void;
}

interface Props {
  busy: boolean;
  context: ComposerContext;
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

/** Box height grows with the text between these bounds (reference: 98 px at rest). */
const MIN_INPUT = 56;
const MAX_INPUT = 180;

/**
 * The composer: a context strip (project · Local/Worktree · branch) over a rounded box holding the
 * input and one control row — `+` (plan, auto, backend), the access pill (mode), any active chips,
 * the model picker, and a round send/stop button.
 */
export function Composer({ busy, context, backend, mode, plan, model, effort, auto, models, modelsError, onBackend, onMode, onPlan, onModel, onEffort, onAuto, onSend, onStop, inputRef }: Props) {
  const [text, setText] = useState("");
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const ta = inputRef ?? fallbackRef;

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(MAX_INPUT, Math.max(MIN_INPUT, el.scrollHeight))}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="composer" data-testid="composer">
      <div className="composer-inner">
        <ContextStrip context={context} />
        <div className={`composer-box${plan ? " plan" : ""}`} data-testid="composer-box">
          <textarea
            ref={ta}
            data-testid="composer-input"
            aria-label="Message"
            value={text}
            placeholder={busy ? "Working… ⌘. to stop" : plan ? "Describe what to plan — nothing will be edited" : "Do anything"}
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
            <PlusMenu busy={busy} backend={backend} plan={plan} auto={auto} onBackend={onBackend} onPlan={onPlan} onAuto={onAuto} />
            <AccessMenu busy={busy} mode={mode} onMode={onMode} />
            {plan && (
              <button className="composer-chip tone-accent" data-testid="plan-chip" aria-label="Plan mode is on. Turn it off" disabled={busy} onClick={() => onPlan(false)}>
                Plan <Icon name="close" size={12} />
              </button>
            )}
            {auto && (
              <button className="composer-chip tone-auto" data-testid="auto-chip" aria-label="Auto routing is on. Turn it off" disabled={busy} onClick={() => onAuto(false)}>
                Auto <Icon name="close" size={12} />
              </button>
            )}
            <span className="spacer" />
            <ModelMenu models={models} model={model} effort={effort} error={modelsError} disabled={busy} onModel={onModel} onEffort={onEffort} />
            {busy ? (
              <IconButton icon="stop" label="Stop" shortcut="⌘." className="send-btn stop" data-testid="stop" tooltipSide="top" onClick={onStop} />
            ) : (
              <IconButton icon="arrow-up" label="Send" shortcut="⌘⏎" className="send-btn" data-testid="send" tooltipSide="top" onClick={submit} disabled={!text.trim()} />
            )}
          </div>
        </div>
        {modelsError && <div className="composer-warn">⚠ {modelsError}</div>}
      </div>
    </div>
  );
}

function ContextStrip({ context }: { context: ComposerContext }) {
  const branch = context.worktree?.branch ?? context.branch;
  return (
    <div className="composer-context" data-testid="composer-context" title={context.cwd}>
      <span className="context-item" data-testid="context-project"><Icon name="folder" size={14} />{context.project}</span>
      {context.onToggleWorktree ? (
        <button className="context-item context-toggle" data-testid="context-kind" data-kind={context.worktree ? "worktree" : "local"} aria-pressed={Boolean(context.worktree)} title={context.worktree ? "Runs in a new git worktree. Click to run in the checkout" : "Runs in the project checkout. Click to use a new git worktree"} onClick={context.onToggleWorktree}>
          <Icon name={context.worktree ? "branch" : "laptop"} size={14} />{context.worktree ? "Worktree" : "Local"}
        </button>
      ) : (
        <span className="context-item" data-testid="context-kind" data-kind={context.worktree ? "worktree" : "local"}>
          <Icon name={context.worktree ? "branch" : "laptop"} size={14} />{context.worktree ? "Worktree" : "Local"}
        </span>
      )}
      {branch && <span className="context-item" data-testid="context-branch"><Icon name="branch" size={14} />{branch}</span>}
    </div>
  );
}

/** `+`: plan mode, Auto routing, and which CLI runs the thread. Everything is disabled while a turn runs. */
function PlusMenu({ busy, backend, plan, auto, onBackend, onPlan, onAuto }: { busy: boolean; backend: BackendId; plan: boolean; auto: boolean; onBackend: (b: BackendId) => void; onPlan: (p: boolean) => void; onAuto: (a: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const pick = (fn: () => void) => () => { fn(); setOpen(false); };
  return (
    <span className="composer-menu">
      <IconButton ref={trigger} icon="plus" label="Plan, Auto and backend" size="md" className="composer-plus-btn" data-testid="composer-plus" aria-haspopup="menu" aria-expanded={open} tooltipSide="top" onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={trigger} label="Composer options" placement="top-start" testId="composer-plus-menu" className="composer-options">
        <MenuItem toggle selected={plan} disabled={busy} data-testid="plan-toggle" onClick={pick(() => onPlan(!plan))}>
          <span className="menu-body">
            <span className="menu-title">Plan mode <Kbd>⇧⌘P</Kbd></span>
            <span className="menu-desc">Investigate read-only and return a plan instead of editing.</span>
          </span>
        </MenuItem>
        <MenuItem toggle selected={auto} disabled={busy} data-testid="auto-toggle" onClick={pick(() => onAuto(!auto))}>
          <span className="menu-body">
            <span className="menu-title">Auto routing</span>
            <span className="menu-desc">A fast judge picks the model, effort and speed for each turn, within your limits.</span>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>Backend</MenuLabel>
        <div role="group" aria-label="Backend" data-testid="backend-picker">
          {BACKENDS.map((b) => (
            <MenuItem key={b.id} checkable selected={backend === b.id} disabled={busy} title={b.hint} onClick={pick(() => onBackend(b.id))}>
              <span className="menu-body"><span className="menu-title">{b.label}</span></span>
            </MenuItem>
          ))}
          {backend === "mock" && (
            <MenuItem checkable selected disabled title="Offline scripted engine (demo)">
              <span className="menu-body"><span className="menu-title">Mock</span></span>
            </MenuItem>
          )}
        </div>
      </Menu>
    </span>
  );
}

const ACCESS_LABEL: Record<Mode, string> = { chat: "Read only", agent: "Agent", "full-access": "Full access" };

/** The access pill: how much the agent may do without asking (the thread's mode). Orange only for full access. */
function AccessMenu({ busy, mode, onMode }: { busy: boolean; mode: Mode; onMode: (m: Mode) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const info = MODES.find((m) => m.id === mode);
  return (
    <span className="composer-menu">
      <button ref={trigger} className={`access-pill${mode === "full-access" ? " full" : ""}`} data-testid="access-picker" data-mode={mode} title={info?.hint} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((v) => !v)}>
        <Icon name="info" size={14} />
        {ACCESS_LABEL[mode]}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={trigger} label="Access" placement="top-start" testId="access-menu" className="access-options">
        {MODES.map((m) => (
          <MenuItem key={m.id} checkable selected={m.id === mode} data-testid="access-option" data-mode={m.id} onClick={() => { onMode(m.id); setOpen(false); }}>
            <span className="menu-body">
              <span className="menu-title">{ACCESS_LABEL[m.id]}</span>
              <span className="menu-desc">{m.hint}</span>
            </span>
          </MenuItem>
        ))}
      </Menu>
    </span>
  );
}
