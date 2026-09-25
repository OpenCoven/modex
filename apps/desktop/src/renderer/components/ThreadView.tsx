import { useEffect, useRef, useState } from "react";
import type { BackendId, Mode, ModelInfo, Project, Thread, ThreadItem } from "../../shared/types";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";

interface Props {
  thread: Thread;
  project: Project;
  items: ThreadItem[];
  onSend: (text: string) => void;
  onStop: () => void;
  onAnswer: (itemId: string, answer: "yes" | "no" | "always") => void;
  onUpdate: (patch: Partial<Pick<Thread, "mode" | "model" | "title" | "backend" | "plan" | "effort">>) => void;
  showChanges: boolean;
  onToggleChanges: () => void;
  changedCount: number;
  models: ModelInfo[];
  modelsError?: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onOpenPath: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  platform: string;
}

/** `/Users/val/x` → `~/x` for display; the full path stays in the tooltip and clipboard. */
export function shortenHome(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

/** Keeps the tail of a long path (the part that distinguishes worktrees), dropping whole leading segments. */
export function tailPath(p: string, max = 40): string {
  if (p.length <= max) return p;
  const parts = p.split("/");
  let out = "";
  for (let i = parts.length - 1; i > 0; i--) {
    const next = "/" + parts[i] + out;
    if (next.length + 1 > max) break;
    out = next;
  }
  return "…" + (out || p.slice(-(max - 1)));
}

export function ThreadView({ thread, project, items, onSend, onStop, onAnswer, onUpdate, showChanges, onToggleChanges, changedCount, models, modelsError, inputRef, onOpenPath, onOpenTerminal, platform }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const busy = thread.status === "running" || thread.status === "waiting";

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, items.at(-1)]);

  return (
    <section className="thread-view">
      <header className="topbar drag">
        <div className="crumbs">
          <span className="crumb">{project.name}</span>
          <span className="sep">/</span>
          <input className="title-input" value={thread.title} onChange={(e) => onUpdate({ title: e.target.value })} spellCheck={false} />
        </div>
        <div className="topbar-right no-drag">
          <span className={`pill backend ${thread.backend}`}>{thread.backend === "claude" ? "Claude" : thread.backend === "codex" ? "Codex" : "Mock"}{thread.model ? ` · ${thread.model}` : ""}</span>
          {thread.plan && <span className="pill plan">▤ Plan</span>}
          <span className={`pill status ${thread.status}`}>{label(thread.status)}</span>
          <button className={`btn small ${showChanges ? "active" : ""}`} onClick={onToggleChanges}>
            Changes{changedCount ? <span className="count">{changedCount}</span> : null}
          </button>
        </div>
      </header>

      <div className="location" role="group" aria-label="Working directory">
        <span className="location-kind" title={thread.worktree ? `Worktree managed by ${thread.worktree.manager === "project-script" ? "the project's scripts/worktree.sh" : "Modex"}` : "Runs directly in the project checkout"}>
          {thread.worktree ? "⑂" : "▸"}
        </span>
        {thread.worktree && <code className="location-branch" title="Branch">{thread.worktree.branch}</code>}
        <code className="location-path" title={thread.cwd}>{tailPath(shortenHome(thread.cwd))}</code>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => onOpenPath(thread.cwd)} title={`Open ${thread.cwd} in ${platform === "darwin" ? "Finder" : "the file manager"}`}>
          {platform === "darwin" ? "Finder" : "Files"}
        </button>
        <button className="btn small ghost" onClick={() => onOpenTerminal(thread.cwd)} title={`Open a terminal at ${thread.cwd}`}>Terminal</button>
        <button className="btn small ghost" onClick={() => void navigator.clipboard.writeText(thread.cwd)} title="Copy the full path">Copy path</button>
      </div>

      <div className="transcript" ref={scroller}>
        {items.length === 0 && (
          <div className="transcript-empty">
            <p>Describe a task. Modex will inspect <code>{thread.cwd}</code>, then read, edit, and run what it needs — asking first when the mode requires it.</p>
          </div>
        )}
        {items.map((item) => <Item key={item.id} item={item} onAnswer={onAnswer} />)}
        {thread.status === "running" && <div className="working"><span className="spinner" /> Working…</div>}
      </div>

      <Composer
        busy={busy}
        backend={thread.backend}
        mode={thread.mode}
        plan={thread.plan}
        model={thread.model}
        effort={thread.effort}
        models={models}
        modelsError={modelsError}
        onBackend={(backend: BackendId) => onUpdate({ backend })}
        onMode={(mode: Mode) => onUpdate({ mode })}
        onPlan={(plan: boolean) => onUpdate({ plan })}
        onModel={(model: string) => onUpdate({ model })}
        onEffort={(effort) => onUpdate({ effort })}
        onSend={onSend}
        onStop={onStop}
        inputRef={inputRef}
      />
    </section>
  );
}

function label(s: Thread["status"]): string {
  return s === "waiting" ? "Needs approval" : s === "running" ? "Working" : s === "error" ? "Error" : "Idle";
}

function Item({ item, onAnswer }: { item: ThreadItem; onAnswer: Props["onAnswer"] }) {
  switch (item.kind) {
    case "user":
      return <div className="msg user"><div className="bubble">{item.text}</div></div>;
    case "assistant":
      return <div className="msg assistant"><Markdown text={item.text} /></div>;
    case "tool":
      return <ToolItem item={item} />;
    case "approval":
      return (
        <div className={`approval ${item.answer ? "answered" : ""}`}>
          <div className="approval-head">
            <span className="shield">⚠</span>
            <span>{item.question}</span>
          </div>
          {item.detail && <pre className="detail">{item.detail}</pre>}
          {item.answer ? (
            <div className="approval-answer">{item.answer === "yes" ? "Approved" : item.answer === "always" ? "Approved — always for this command" : "Denied"}</div>
          ) : (
            <div className="row">
              <button className="btn primary small" onClick={() => onAnswer(item.id, "yes")}>Approve</button>
              {item.canAlways !== false && <button className="btn small" onClick={() => onAnswer(item.id, "always")}>Always</button>}
              <button className="btn danger small" onClick={() => onAnswer(item.id, "no")}>Deny</button>
            </div>
          )}
        </div>
      );
    case "notice":
      return <div className={`notice ${item.level}`}>{item.text}</div>;
    case "thinking":
      return <ThinkingItem item={item} />;
  }
}

/** Collapsible reasoning: open while the model is still thinking, folded to one line once done. */
function ThinkingItem({ item }: { item: Extract<ThreadItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? item.status === "running";
  const secs = item.durationMs != null ? Math.max(1, Math.round(item.durationMs / 1000)) : null;
  return (
    <div className={`thinking ${item.status} ${isOpen ? "open" : ""}`}>
      <button className="thinking-head" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
        <span className="thinking-icon">{item.status === "running" ? <span className="spinner" /> : "◌"}</span>
        <span className={`thinking-label ${item.status === "running" ? "shimmer" : ""}`}>{item.status === "running" ? "Thinking…" : secs ? `Thought for ${secs}s` : "Thinking"}</span>
        <span className="spacer" />
        <span className="chev">{isOpen ? "▾" : "▸"}</span>
      </button>
      {isOpen && (item.text.trim() ? <div className="thinking-body"><Markdown text={item.text} /></div> : <div className="thinking-body dim">{item.status === "running" ? "…" : "The CLI did not share the reasoning text for this step."}</div>)}
    </div>
  );
}

function ToolItem({ item }: { item: Extract<ThreadItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const icon = item.name === "shell" ? "›_" : item.name === "apply_patch" || item.name === "write_file" ? "✎" : "◫";
  return (
    <div className={`tool ${item.status} ${item.ok === false ? "failed" : ""}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-icon">{icon}</span>
        <code className="tool-title">{item.title}</code>
        <span className="spacer" />
        {item.status === "running" ? <span className="spinner" /> : <span className="tool-meta">{item.ok === false ? "failed" : "done"}{item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}</span>}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body">
          {item.name === "apply_patch" && typeof item.args.patch === "string" ? <Patch text={item.args.patch} /> : null}
          {item.output ? <pre className="output">{item.output}</pre> : item.status === "running" ? <pre className="output dim">running…</pre> : null}
        </div>
      )}
    </div>
  );
}

export function Patch({ text }: { text: string }) {
  return (
    <pre className="patch">
      {text.split("\n").map((l, i) => {
        const cls = l.startsWith("***") ? "hdr" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "";
        return <div key={i} className={cls}>{l || " "}</div>;
      })}
    </pre>
  );
}
