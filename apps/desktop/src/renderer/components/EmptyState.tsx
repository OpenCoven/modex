import { Kbd } from "./ui/Kbd";

interface Props {
  onAddProject: () => void;
}

/** First run: no projects yet. With a project, a new chat is a draft (DraftView) instead. */
export function EmptyState({ onAddProject }: Props) {
  return (
    <div className="empty" data-testid="empty-state">
      <div className="empty-card">
        <div className="brand-mark big">◆</div>
        <h1 data-testid="empty-title">What are we building?</h1>
        <p>Modex runs Claude Code and Codex — through their CLIs, with your existing logins — in your local repositories. Each thread works in its project (or its own git worktree), streams every command and edit as it happens, and asks before doing anything outside the sandbox.</p>
        <div className="row">
          <button className="btn primary" data-testid="empty-open-project" onClick={onAddProject}>Open project…</button>
        </div>
        <ul className="features">
          <li><b>Chat</b> — read-only, asks before every command or edit.</li>
          <li><b>Agent</b> — edits and runs commands inside the project; asks to leave it.</li>
          <li><b>Agent (full access)</b> — no sandbox, no prompts.</li>
          <li><b>Plan</b> — read-only investigation that ends in a plan. <Kbd>⌘N</Kbd> new chat · <Kbd>⌘⏎</Kbd> send · <Kbd>⇧⌘P</Kbd> plan</li>
        </ul>
      </div>
    </div>
  );
}
