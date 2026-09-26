import { useRef, useState, type ReactNode } from "react";
import type { AppState, Thread } from "../../shared/types";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { Menu, MenuItem } from "./ui/Menu";

interface Props {
  state: AppState;
  selected: string | null;
  onSelect: (threadId: string) => void;
  /** The project an open draft belongs to; its row is highlighted like a selection. */
  draftProjectId?: string;
  onAddProject: () => void;
  /** "New chat": a thread in the current project (the selected thread's, else the first). */
  onNewChat: () => void;
  onNewThread: (projectId: string, worktree?: boolean) => void;
  onDeleteThread: (thread: Thread) => void;
  onRemoveProject: (projectId: string) => void;
}

/** Threads shown per project before "Show more". */
export const THREADS_PER_PROJECT = 5;

export function Sidebar({ state, selected, onSelect, draftProjectId, onAddProject, onNewChat, onNewThread, onDeleteThread, onRemoveProject }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const groups = state.projects.map((p) => {
    const all = state.threads.filter((t) => t.projectId === p.id);
    return { project: p, all, matches: q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all };
  });
  const noMatches = q && groups.every((g) => g.matches.length === 0);

  return (
    <aside className="sidebar" data-testid="sidebar">
      <header className="sidebar-head">
        <h1 className="sidebar-title" data-testid="sidebar-title">Modex</h1>
        <span className="spacer" />
        <IconButton icon="search" label="Search threads" size="md" data-testid="search-toggle" aria-pressed={searching} onClick={() => (searching ? closeSearch() : setSearching(true))} />
      </header>
      {searching && (
        <div className="sidebar-search">
          <Icon name="search" size={14} />
          <input
            autoFocus
            data-testid="thread-search"
            aria-label="Search threads"
            placeholder="Search threads"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && closeSearch()}
          />
        </div>
      )}
      <button className="side-row new-chat" data-testid="new-chat" onClick={onNewChat} disabled={state.projects.length === 0}>
        <Icon name="compose" className="side-row-icon" />
        <span className="side-row-label">New chat</span>
      </button>

      <div className="section-label">
        <span>Projects</span>
        <span className="spacer" />
        <IconButton icon="plus" label="Open project…" data-testid="add-project" onClick={onAddProject} />
      </div>
      <nav className="projects" aria-label="Projects">
        {state.projects.length === 0 && <p className="side-hint">No projects yet. Open a folder to start a thread.</p>}
        {noMatches && <p className="side-hint" data-testid="search-empty">No threads match “{query.trim()}”.</p>}
        {groups.map(({ project: p, all, matches }) => {
          if (q && matches.length === 0) return null;
          const isCollapsed = !q && collapsed[p.id];
          const selectedIndex = matches.findIndex((t) => t.id === selected);
          const showAll = Boolean(q) || expanded[p.id] || selectedIndex >= THREADS_PER_PROJECT;
          const visible = showAll ? matches : matches.slice(0, THREADS_PER_PROJECT);
          const busy = all.some((t) => t.status === "running" || t.status === "waiting");
          return (
            <section key={p.id} className="project" data-testid="project" data-project-id={p.id}>
              <div className={`side-row project-row${p.id === draftProjectId ? " selected" : ""}`} title={p.path} data-draft={p.id === draftProjectId ? "true" : undefined}>
                <button className="project-toggle" data-testid="project-toggle" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}>
                  <Icon name="folder" className="side-row-icon" />
                  <span className="side-row-label" data-testid="project-name">{p.name}</span>
                </button>
                {isCollapsed && busy && <span className="row-status running" title="A thread in this project is working" />}
                <span className="row-actions">
                  <IconButton icon="plus" label="New chat" shortcut="⌘N" reveal data-testid="project-new-thread" onClick={() => onNewThread(p.id)} />
                  <IconButton icon="branch" label="New chat in a git worktree" shortcut="⇧⌘N" reveal data-testid="project-new-worktree-thread" onClick={() => onNewThread(p.id, true)} />
                  <RowMenu label="Project actions" testId="project-menu">
                    <MenuItem data-testid="project-remove" className="danger" onClick={() => onRemoveProject(p.id)}>Remove project</MenuItem>
                  </RowMenu>
                </span>
              </div>
              {!isCollapsed && (
                <ul className="threads">
                  {all.length === 0 && <li className="side-hint small">No threads</li>}
                  {visible.map((t) => (
                    <li key={t.id} className={`side-row thread-row${t.id === selected ? " selected" : ""}`} data-testid="thread-row" data-thread-id={t.id} data-status={t.status} aria-current={t.id === selected ? "true" : undefined}>
                      <button className="thread-main" onClick={() => onSelect(t.id)}>
                        <span className="side-row-label" data-testid="thread-row-title">{t.title}</span>
                      </button>
                      <span className="row-meta">
                        <RowStatus status={t.status} />
                        {t.worktree && <span className="row-glyph" data-testid="thread-row-worktree" title={`Worktree · ${t.worktree.branch}`}><Icon name="branch" size={14} /></span>}
                      </span>
                      <span className="row-actions">
                        <RowMenu label="Thread actions" testId="thread-menu">
                          <MenuItem data-testid="thread-delete" className="danger" onClick={() => onDeleteThread(t)}>Delete thread</MenuItem>
                        </RowMenu>
                      </span>
                    </li>
                  ))}
                  {!q && matches.length > THREADS_PER_PROJECT && selectedIndex < THREADS_PER_PROJECT && (
                    <li>
                      <button className="side-row show-more" data-testid="show-more" aria-expanded={Boolean(expanded[p.id])} onClick={() => setExpanded((x) => ({ ...x, [p.id]: !x[p.id] }))}>
                        <span className="side-row-label">{expanded[p.id] ? "Show less" : "Show more"}</span>
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
      </nav>
    </aside>
  );
}

/** Right-hand status on a thread row: a spinning ring while working, a dot when it needs you or failed. */
function RowStatus({ status }: { status: Thread["status"] }) {
  if (status === "idle") return null;
  const title = status === "running" ? "Working" : status === "waiting" ? "Needs approval" : "Error";
  return <span className={`row-status ${status}`} data-testid="thread-row-status" title={title} />;
}

/** A hover "⋯" button on a sidebar row that opens a small command menu. */
function RowMenu({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <span className="row-menu" onClick={(e) => e.stopPropagation()}>
      <IconButton ref={trigger} icon="more" label={label} reveal data-testid={testId} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={trigger} label={label} placement="bottom-end">
        <span className="menu-close-on-select" onClick={() => setOpen(false)}>{children}</span>
      </Menu>
    </span>
  );
}
