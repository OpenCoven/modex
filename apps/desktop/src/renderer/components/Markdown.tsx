import type { ReactNode } from "react";

/** Small, dependency-free Markdown subset: headings, fenced code, inline code, bold, lists, paragraphs. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key++} className="code" data-lang={lang}>{code.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const content = inline(h[2]!);
      blocks.push(level === 1 ? <h2 key={key++}>{content}</h2> : level === 2 ? <h3 key={key++}>{content}</h3> : <h4 key={key++}>{content}</h4>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: ReactNode[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(<li key={i}>{inline(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>), i++;
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith("```") && !/^(#{1,3})\s/.test(lines[i]!) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else out.push(<b key={k++}>{tok.slice(2, -2)}</b>);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
