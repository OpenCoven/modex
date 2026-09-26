import { useEffect, useState } from "react";
import type { ChangesSnapshot, Thread } from "../../shared/types";
import { bridge } from "../bridge";
import { Pill } from "./ui/Pill";

interface Props {
  thread: Thread;
  changes: ChangesSnapshot | null;
  onRefresh: () => void;
  onRevert: (path: string) => void;
}

export function ChangesPanel({ thread, changes, onRefresh, onRevert }: Props) {
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");

  useEffect(() => {
    if (!changes?.files.length) { setFile(null); setDiff(""); return; }
    if (!file || !changes.files.some((f) => f.path === file)) setFile(changes.files[0]!.path);
  }, [changes]);

  useEffect(() => {
    if (!file) return;
    let alive = true;
    void bridge.invoke("changes:diff", { threadId: thread.id, path: file }).then((d) => alive && setDiff(d)).catch(() => alive && setDiff(""));
    return () => { alive = false; };
  }, [file, thread.id, changes]);

  const totals = (changes?.files ?? []).reduce((acc, f) => ({ a: acc.a + f.additions, d: acc.d + f.deletions }), { a: 0, d: 0 });

  return (
    <aside className="changes" data-testid="changes-panel">
      <header className="changes-head drag">
        <span className="changes-title">Changes</span>
        {changes?.branch && <Pill className="mono">{changes.branch}</Pill>}
        <span className="spacer" />
        <span className="stat add">+{totals.a}</span>
        <span className="stat del">−{totals.d}</span>
        <button className="icon no-drag" data-testid="changes-refresh" title="Refresh" onClick={onRefresh}>↻</button>
      </header>
      {!changes ? (
        <p className="hint pad">Loading…</p>
      ) : !changes.isRepo ? (
        <p className="hint pad">Not a git repository — changes can't be tracked here.</p>
      ) : changes.files.length === 0 ? (
        <p className="hint pad">Working tree clean.</p>
      ) : (
        <>
          <ul className="files">
            {changes.files.map((f) => (
              <li key={f.path} data-testid="changes-file" data-path={f.path} aria-current={f.path === file ? "true" : undefined} className={`file ${f.path === file ? "selected" : ""}`} onClick={() => setFile(f.path)}>
                <span className={`code c-${f.code.trim()[0] ?? "M"}`}>{codeLabel(f.code)}</span>
                <span className="file-path" data-testid="changes-file-path" title={f.path}>{f.path}</span>
                <span className="stat add">+{f.additions}</span>
                <span className="stat del">−{f.deletions}</span>
                <button className="icon dim" data-testid="changes-revert" title="Discard changes to this file" onClick={(e) => { e.stopPropagation(); onRevert(f.path); }}>↶</button>
              </li>
            ))}
          </ul>
          <div className="diff" data-testid="changes-diff">
            {file && <div className="diff-file">{file}</div>}
            <Diff text={diff} />
          </div>
        </>
      )}
    </aside>
  );
}

function codeLabel(code: string): string {
  const c = code.trim()[0] ?? "";
  return c === "?" ? "A" : c === "R" ? "R" : c === "D" ? "D" : c === "A" ? "A" : "M";
}

export function Diff({ text }: { text: string }) {
  if (!text) return <p className="hint pad">No textual diff.</p>;
  return (
    <pre className="diff-body" data-testid="diff">
      {text.split("\n").map((l, i) => {
        const cls = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("new file") || l.startsWith("deleted file")
          ? "hdr" : l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
        return <div key={i} className={cls} data-line={cls || "context"}>{l || " "}</div>;
      })}
    </pre>
  );
}
