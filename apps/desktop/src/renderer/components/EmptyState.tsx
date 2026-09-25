interface Props {
  hasProjects: boolean;
  onAddProject: () => void;
  onNewThread: () => void;
}

export function EmptyState({ hasProjects, onAddProject, onNewThread }: Props) {
  return (
    <div className="empty">
      <div className="drag topbar" />
      <div className="empty-card">
        <div className="brand-mark big">◆</div>
        <h1>What are we building?</h1>
        <p>Modex runs coding agents in your local repositories. Each thread works in its project (or in its own git worktree), shows every command and edit as it happens, and asks before doing anything outside the sandbox.</p>
        <div className="row">
          {hasProjects ? <button className="btn primary" onClick={onNewThread}>New thread</button> : null}
          <button className={`btn ${hasProjects ? "" : "primary"}`} onClick={onAddProject}>Open project…</button>
        </div>
        <ul className="features">
          <li><b>Chat</b> — read-only, asks before every command or edit.</li>
          <li><b>Agent</b> — edits and runs commands inside the project; asks to leave it.</li>
          <li><b>Agent (full access)</b> — no sandbox, no prompts.</li>
        </ul>
      </div>
    </div>
  );
}
