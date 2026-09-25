import { useEffect, useRef, useState } from "react";
import type { Mode, Project, Thread, ThreadItem } from "../../shared/types";
import { MODES, MODELS } from "../../shared/types";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";

interface Props {
  thread: Thread;
  project: Project;
  items: ThreadItem[];
  onSend: (text: string) => void;
  onStop: () => void;
  onAnswer: (itemId: string, answer: "yes" | "no" | "always") => void;
  onUpdate: (patch: Partial<Pick<Thread, "mode" | "model" | "title">>) => void;
  showChanges: boolean;
  onToggleChanges: () => void;
  changedCount: number;
}

export function ThreadView({ thread, project, items, onSend, onStop, onAnswer, onUpdate, showChanges, onToggleChanges, changedCount }: Props) {
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
          {thread.worktree && <span className="pill" title={thread.worktree.path}>⑂ {thread.worktree.branch}</span>}
          <span className={`pill status ${thread.status}`}>{label(thread.status)}</span>
          <button className={`btn small ${showChanges ? "active" : ""}`} onClick={onToggleChanges}>
            Changes{changedCount ? <span className="count">{changedCount}</span> : null}
          </button>
        </div>
      </header>

      <div className="transcript" ref={scroller}>
        {items.length === 0 && (
          <div className="transcript-empty">
            <p>Describe a task. Modex will inspect <code>{thread.cwd}</code>, then read, edit, and run what it needs — asking first when the mode requires it.</p>
          </div>
        )}
        {items.map((item) => <Item key={item.id} item={item} onAnswer={onAnswer} />)}
        {thread.status === "running" && <div className="thinking"><span className="spinner" /> Working…</div>}
      </div>

      <Composer
        busy={busy}
        mode={thread.mode}
        model={thread.model}
        modes={MODES}
        models={MODELS}
        onMode={(mode: Mode) => onUpdate({ mode })}
        onModel={(model: string) => onUpdate({ model })}
        onSend={onSend}
        onStop={onStop}
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
              <button className="btn small" onClick={() => onAnswer(item.id, "always")}>Always</button>
              <button className="btn danger small" onClick={() => onAnswer(item.id, "no")}>Deny</button>
            </div>
          )}
        </div>
      );
    case "notice":
      return <div className={`notice ${item.level}`}>{item.text}</div>;
  }
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
