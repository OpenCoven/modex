import { useState } from "react";
import type { AppState, Thread } from "../../shared/types";

interface Props {
  state: AppState;
  selected: string | null;
  onSelect: (threadId: string) => void;
  onAddProject: () => void;
  onNewThread: (projectId: string, worktree?: boolean) => void;
  onDeleteThread: (thread: Thread) => void;
  onRemoveProject: (projectId: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({ state, selected, onSelect, onAddProject, onNewThread, onDeleteThread, onRemoveProject, onOpenSettings }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-head drag">
        <span className="brand">
          <span className="brand-mark">◆</span> Modex
        </span>
      </div>
      <div className="sidebar-actions">
        <button className="btn ghost full" onClick={onAddProject} data-testid="add-project">
          <span className="plus">+</span> Open project…
        </button>
      </div>
      <nav className="projects">
        {state.projects.length === 0 && <p className="hint">No projects yet. Open a folder to start a thread.</p>}
        {state.projects.map((p) => {
          const threads = state.threads.filter((t) => t.projectId === p.id);
          const running = threads.filter((t) => t.status === "running" || t.status === "waiting").length;
          const isCollapsed = collapsed[p.id];
          return (
            <section key={p.id} className="project" data-testid="project" data-project-id={p.id}>
              <header className="project-head" title={p.path}>
                <button className="chev" onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))} aria-label={isCollapsed ? "Expand" : "Collapse"}>
                  {isCollapsed ? "▸" : "▾"}
                </button>
                <span className="project-name" data-testid="project-name">{p.name}</span>
                {running > 0 && <span className="badge live">{running}</span>}
                <span className="spacer" />
                <button className="icon" data-testid="project-new-thread" title="New thread (⌘N)" onClick={() => onNewThread(p.id)}>+</button>
                <button className="icon" data-testid="project-new-worktree-thread" title="New thread in a git worktree (⇧⌘N)" onClick={() => onNewThread(p.id, true)}>⑂</button>
                <button className="icon dim" data-testid="project-remove" title="Remove project" onClick={() => onRemoveProject(p.id)}>×</button>
              </header>
              {!isCollapsed && (
                <ul className="threads">
                  {threads.length === 0 && <li className="hint small">No threads</li>}
                  {threads.map((t) => (
                    <li key={t.id} className={`thread ${t.id === selected ? "selected" : ""}`} onClick={() => onSelect(t.id)} data-testid="thread-row" data-thread-id={t.id} data-status={t.status} aria-current={t.id === selected ? "true" : undefined}>
                      <StatusDot status={t.status} />
                      <span className="thread-title" data-testid="thread-row-title">{t.title}</span>
                      {t.worktree && <span className="tag" title={`worktree ${t.worktree.branch}`}>⑂</span>}
                      <button className="icon dim del" data-testid="thread-delete" title="Delete thread" onClick={(e) => { e.stopPropagation(); onDeleteThread(t); }}>×</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </nav>
      <footer className="sidebar-foot">
        <button className="btn ghost full" onClick={onOpenSettings} data-testid="open-settings">⚙ Settings</button>
        <div className="foot-meta">
          {state.settings.default_backend === "mock" ? "offline mock engine" : `default: ${state.settings.default_backend === "claude" ? "Claude Code CLI" : "Codex CLI"} · ${state.settings.default_mode}`}
        </div>
      </footer>
    </aside>
  );
}

export function StatusDot({ status }: { status: Thread["status"] }) {
  return <span className={`dot ${status}`} title={status} />;
}
