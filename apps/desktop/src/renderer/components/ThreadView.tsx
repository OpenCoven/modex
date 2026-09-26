import { Fragment, useEffect, useRef, useState } from "react";
import type { BackendId, Mode, ModelInfo, Project, Thread, ThreadItem, ThreadPatch } from "../../shared/types";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { Icon } from "./ui/Icon";

interface Props {
  thread: Thread;
  project: Project;
  items: ThreadItem[];
  onSend: (text: string) => void;
  onStop: () => void;
  onAnswer: (itemId: string, answer: "yes" | "no" | "always") => void;
  onUpdate: (patch: ThreadPatch) => void;
  models: ModelInfo[];
  modelsError?: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onOpenPath: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  platform: string;
  /** The checkout's current branch (from the Changes snapshot), for the composer's context strip. */
  branch?: string;
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

export function ThreadView({ thread, project, items, onSend, onStop, onAnswer, onUpdate, models, modelsError, inputRef, onOpenPath, onOpenTerminal, platform, branch }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const busy = thread.status === "running" || thread.status === "waiting";
  // Follow new output only while the reader is at (or near) the bottom; scrolling up to read stops it.
  const stick = useRef(true);
  // Where auto-scroll last put the view. Content can change (a ticking header, streamed text) before the
  // browser delivers the reader's scroll event, so "has the reader moved it?" is read from the position
  // itself: anything above this mark means they scrolled, and following waits until they are back down.
  const autoTop = useRef(0);
  const follow = useRef((el: HTMLDivElement) => {
    if (el.scrollTop < autoTop.current - 2) stick.current = isNearBottom(el);
    if (!stick.current) return;
    el.scrollTop = el.scrollHeight;
    autoTop.current = el.scrollTop;
  }).current;
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = isNearBottom(el);
  };
  useEffect(() => {
    stick.current = true;
    autoTop.current = 0;
  }, [thread.id]);
  // Output also grows without new items (streamed text, a pane opening and re-wrapping the prose):
  // keep following those while stuck to the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onChange = () => follow(el);
    const resize = new ResizeObserver(onChange);
    resize.observe(el);
    const mutate = new MutationObserver(onChange);
    mutate.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutate.disconnect();
    };
  }, []);
  useEffect(() => {
    const el = scroller.current;
    // The reader's own new message always brings the view down.
    if (items.at(-1)?.kind === "user") {
      stick.current = true;
      autoTop.current = 0;
    }
    if (el) follow(el);
  }, [thread.id, items.length, items.at(-1)]);
  const turns = groupTurns(items);
  let lastUser = -1;
  turns.forEach((t, i) => { if (t.user) lastUser = i; });

  return (
    <section className="thread-view" data-testid="thread-view" data-thread-id={thread.id}>
      <div className="location" role="group" aria-label="Working directory" data-testid="thread-location">
        <span className="location-kind" data-testid="location-kind" data-kind={thread.worktree ? "worktree" : "local"} title={thread.worktree ? `Worktree managed by ${thread.worktree.manager === "project-script" ? "the project's scripts/worktree.sh" : "Modex"}` : "Runs directly in the project checkout"}>
          {thread.worktree ? "⑂" : "▸"}
        </span>
        {thread.worktree && <code className="location-branch" data-testid="location-branch" title="Branch">{thread.worktree.branch}</code>}
        <code className="location-path" data-testid="location-path" title={thread.cwd}>{tailPath(shortenHome(thread.cwd))}</code>
        <span className="spacer" />
        <button className="btn small ghost" data-testid="action-open-folder" onClick={() => onOpenPath(thread.cwd)} title={`Open ${thread.cwd} in ${platform === "darwin" ? "Finder" : "the file manager"}`}>
          {platform === "darwin" ? "Finder" : "Files"}
        </button>
        <button className="btn small ghost" data-testid="action-open-terminal" onClick={() => onOpenTerminal(thread.cwd)} title={`Open a terminal at ${thread.cwd}`}>Terminal</button>
        <button className="btn small ghost" data-testid="action-copy-path" onClick={() => void navigator.clipboard.writeText(thread.cwd)} title="Copy the full path">Copy path</button>
      </div>

      <div className="transcript" ref={scroller} data-testid="transcript" onScroll={onScroll}>
        {items.length === 0 && (
          <div className="transcript-empty">
            <p>Describe a task. Modex will inspect <code>{thread.cwd}</code>, then read, edit, and run what it needs — asking first when the mode requires it.</p>
          </div>
        )}
        {turns.map((turn, i) => (
          <Fragment key={turn.user?.id ?? `pre-${i}`}>
            {turn.user && <Item item={turn.user} onAnswer={onAnswer} />}
            {turn.user && (i === lastUser && busy ? <TurnHeader start={turn.user.at} status={thread.status} /> : turn.rest.length > 0 && <TurnHeader start={turn.user.at} end={turnEnd(turn.rest)} />)}
            {turn.rest.map((item) => <Item key={item.id} item={item} onAnswer={onAnswer} />)}
          </Fragment>
        ))}
      </div>

      <Composer
        busy={busy}
        context={{ project: project.name, cwd: thread.cwd, worktree: thread.worktree, branch }}
        backend={thread.backend}
        mode={thread.mode}
        plan={thread.plan}
        model={thread.model}
        effort={thread.effort}
        auto={Boolean(thread.auto)}
        models={models}
        modelsError={modelsError}
        onBackend={(backend: BackendId) => onUpdate({ backend })}
        onMode={(mode: Mode) => onUpdate({ mode })}
        onPlan={(plan: boolean) => onUpdate({ plan })}
        onModel={(model: string) => onUpdate({ model })}
        onEffort={(effort) => onUpdate({ effort })}
        onAuto={(auto) => onUpdate({ auto })}
        onSend={onSend}
        onStop={onStop}
        inputRef={inputRef}
      />
    </section>
  );
}

/** Within this many px of the bottom counts as "at the bottom" for auto-scroll. */
const STICK_PX = 80;
export function isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
}

interface Turn {
  user?: Extract<ThreadItem, { kind: "user" }>;
  rest: ThreadItem[];
}
/** Splits the transcript at each user message: one turn = a message and everything the agent did for it. */
function groupTurns(items: ThreadItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === "user") turns.push({ user: item, rest: [] });
    else if (turns.length) turns.at(-1)!.rest.push(item);
    else turns.push({ rest: [item] });
  }
  return turns;
}
/** When a finished turn ended: its last item's time, plus that item's own duration when it has one. */
function turnEnd(rest: ThreadItem[]): number {
  return Math.max(...rest.map((i) => Date.parse(i.at) + ("durationMs" in i && typeof i.durationMs === "number" ? i.durationMs : 0)));
}
/** 7s · 1m 36s · 1h 4m */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "Working for 7s" (live, ticking) or "Worked for 1m 36s" above a rule, between a message and the agent's work. */
function TurnHeader({ start, end, status }: { start: string; end?: number; status?: Thread["status"] }) {
  const live = end === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const elapsed = formatElapsed((live ? now : end) - Date.parse(start));
  const label = !live ? `Worked for ${elapsed}` : status === "waiting" ? `Waiting for approval · ${elapsed}` : `Working for ${elapsed}`;
  return (
    <div className={`turn-header${live ? " live" : ""}`} data-testid="turn-header" data-live={live ? "true" : "false"}>
      <span className="turn-label" data-testid="turn-label">{label}</span>
    </div>
  );
}

function Item({ item, onAnswer }: { item: ThreadItem; onAnswer: Props["onAnswer"] }) {
  switch (item.kind) {
    case "user":
      return <div className="msg user" data-testid="item" data-item-kind="user"><div className="bubble" data-testid="item-text">{item.text}</div></div>;
    case "assistant":
      return <div className="msg assistant" data-testid="item" data-item-kind="assistant"><Markdown text={item.text} /></div>;
    case "tool":
      return <ToolItem item={item} />;
    case "approval":
      return (
        <div className={`approval ${item.answer ? "answered" : ""}`} data-testid="item" data-item-kind="approval" data-answered={item.answer ? "true" : "false"}>
          <div className="approval-head" data-testid="approval-question">
            <span className="shield">⚠</span>
            <span>{item.question}</span>
          </div>
          {item.detail && <pre className="detail">{item.detail}</pre>}
          {item.answer ? (
            <div className="approval-answer" data-testid="approval-answer">{item.answer === "yes" ? "Approved" : item.answer === "always" ? "Approved — always for this command" : "Denied"}</div>
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
      return <div className={`notice ${item.level}`} data-testid="item" data-item-kind="notice" data-level={item.level}>{item.text}</div>;
    case "thinking":
      return <ThinkingItem item={item} />;
    case "route":
      return <RouteItem item={item} />;
  }
}

/** One Auto decision: what runs this turn, and — expanded — the judge's reasons. */
function RouteItem({ item }: { item: Extract<ThreadItem, { kind: "route" }> }) {
  const [open, setOpen] = useState(false);
  const backend = item.backend === "claude" ? "Claude" : item.backend === "codex" ? "Codex" : "Mock";
  const extras = [item.effort, item.fast ? "fast" : null].filter(Boolean).join(" · ");
  return (
    <div className={`route ${item.source} ${open ? "open" : ""}`} data-testid="item" data-item-kind="route" data-source={item.source}>
      <button className="route-head" data-testid="item-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="route-icon">⚡</span>
        <span className="route-label" data-testid="route-label">
          {item.pinned ? "Auto kept" : "Auto picked"} <b>{backend} · {item.model}</b>{extras ? ` · ${extras}` : ""}
        </span>
        <span className="route-meta" data-testid="route-meta">{item.task.replace(/_/g, " ")} · {item.source === "jev" ? `Jev ${item.confidence.toFixed(2)}` : "heuristic"}</span>
        <Icon name="chevron-right" size={12} className={`chev${open ? " open" : ""}`} />
      </button>
      {open && (
        <ul className="route-body" data-testid="item-body">
          {item.reasons.map((r, i) => <li key={i}>{r}</li>)}
          <li className="dim">Judged in {item.durationMs} ms · complexity {item.complexity}/3 · task confidence {item.confidence.toFixed(2)}</li>
        </ul>
      )}
    </div>
  );
}

/** Collapsible reasoning: open while the model is still thinking, folded to one line once done. */
function ThinkingItem({ item }: { item: Extract<ThreadItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? item.status === "running";
  const secs = item.durationMs != null ? Math.max(1, Math.round(item.durationMs / 1000)) : null;
  return (
    <div className={`thinking ${item.status} ${isOpen ? "open" : ""}`} data-testid="item" data-item-kind="thinking" data-status={item.status}>
      <button className="thinking-head" data-testid="item-toggle" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
        <span className={`thinking-label ${item.status === "running" ? "shimmer" : ""}`} data-testid="thinking-label">{item.status === "running" ? "Thinking…" : secs ? `Thought for ${secs}s` : "Thinking"}</span>
        <span className="spacer" />
        <Icon name="chevron-right" size={12} className={`chev${isOpen ? " open" : ""}`} />
      </button>
      {isOpen && (item.text.trim() ? <div className="thinking-body" data-testid="item-body"><Markdown text={item.text} /></div> : <div className="thinking-body dim" data-testid="item-body">{item.status === "running" ? "…" : "The CLI did not share the reasoning text for this step."}</div>)}
    </div>
  );
}

function ToolItem({ item }: { item: Extract<ThreadItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const icon = item.name === "shell" ? "›_" : item.name === "apply_patch" || item.name === "write_file" ? "✎" : "◫";
  return (
    <div className={`tool ${item.status} ${item.ok === false ? "failed" : ""}`} data-testid="item" data-item-kind="tool" data-status={item.status} data-ok={item.ok === false ? "false" : "true"}>
      <button className="tool-head" data-testid="item-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-icon">{icon}</span>
        <code className="tool-title" data-testid="tool-title">{item.title}</code>
        <span className="spacer" />
        {item.status === "running" ? <span className="spinner" /> : <span className="tool-meta">{item.ok === false ? "failed" : "done"}{item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}</span>}
        <Icon name="chevron-right" size={12} className={`chev${open ? " open" : ""}`} />
      </button>
      {open && (
        <div className="tool-body" data-testid="item-body">
          {item.name === "apply_patch" && typeof item.args.patch === "string" ? <Patch text={item.args.patch} /> : null}
          {item.output ? <pre className="output" data-testid="tool-output">{item.output}</pre> : item.status === "running" ? <pre className="output dim">running…</pre> : null}
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
