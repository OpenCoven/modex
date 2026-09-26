import { useEffect, useRef, useState } from "react";
import type { Thread } from "../../shared/types";
import { IconButton } from "./ui/IconButton";
import { Pill, type PillTone } from "./ui/Pill";

interface Props {
  thread: Thread | null;
  onRename: (title: string) => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  showChanges: boolean;
  onToggleChanges: () => void;
  changedCount: number;
}

const STATUS_TONE: Record<Thread["status"], PillTone> = { idle: "neutral", running: "accent", waiting: "warn", error: "danger" };
const STATUS_LABEL: Record<Thread["status"], string> = { idle: "Idle", running: "Working", waiting: "Needs approval", error: "Error" };

/**
 * The 42 px window titlebar (a drag region). Left, over the rail and sidebar: space for the traffic
 * lights, back/forward through selected threads, and the sidebar toggle. Right, over the thread: its
 * title (double-click to rename) and the thread's status and Changes controls.
 */
export function TitleBar({ thread, onRename, canBack, canForward, onBack, onForward, sidebarOpen, onToggleSidebar, showChanges, onToggleChanges, changedCount }: Props) {
  return (
    <header className={`titlebar drag${sidebarOpen ? "" : " sidebar-closed"}`} data-testid="titlebar">
      <div className="titlebar-nav">
        <IconButton icon="arrow-left" label="Back" size="md" data-testid="nav-back" disabled={!canBack} onClick={onBack} />
        <IconButton icon="arrow-right" label="Forward" size="md" data-testid="nav-forward" disabled={!canForward} onClick={onForward} />
        <IconButton icon="sidebar" label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} size="md" data-testid="sidebar-toggle" aria-pressed={sidebarOpen} onClick={onToggleSidebar} />
      </div>
      {thread && (
        <div className="titlebar-main">
          <ThreadTitle key={thread.id} title={thread.title} onRename={onRename} />
          <span className="spacer" />
          <div className="titlebar-actions">
            <Pill tone={thread.backend === "mock" ? "neutral" : thread.backend} data-testid="thread-backend">{thread.backend === "claude" ? "Claude" : thread.backend === "codex" ? "Codex" : "Mock"}{thread.model ? ` · ${thread.model}` : ""}</Pill>
            {thread.auto && <Pill tone="auto" data-testid="auto-indicator" title="Auto routing is on for this thread">⚡ Auto</Pill>}
            {thread.plan && <Pill tone="accent" data-testid="plan-indicator">▤ Plan</Pill>}
            <Pill tone={STATUS_TONE[thread.status]} data-testid="thread-status" data-status={thread.status}>{STATUS_LABEL[thread.status]}</Pill>
            <button className={`btn small ${showChanges ? "active" : ""}`} onClick={onToggleChanges} data-testid="changes-toggle" aria-pressed={showChanges}>
              Changes{changedCount ? <span className="count">{changedCount}</span> : null}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

/** Reads as text; double-click (or Enter while focused) to edit. Enter/blur saves, Escape cancels, blank is refused. */
function ThreadTitle({ title, onRename }: { title: string; onRename: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setDraft(title); }, [title, editing]);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const commit = () => {
    const t = draft.trim();
    setEditing(false);
    if (t && t !== title) onRename(t);
    else setDraft(title);
  };
  return (
    <input
      ref={input}
      className={`title-text${editing ? " editing" : ""}`}
      data-testid="thread-title"
      aria-label="Thread title"
      title={editing ? undefined : "Double-click to rename"}
      readOnly={!editing}
      value={draft}
      spellCheck={false}
      onDoubleClick={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => editing && commit()}
      onKeyDown={(e) => {
        if (!editing) {
          if (e.key === "Enter") { e.preventDefault(); setEditing(true); }
          return;
        }
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); setDraft(title); setEditing(false); }
      }}
    />
  );
}
