/**
 * Implements the Codex `apply_patch` format:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.txt
 *   +line one
 *   *** Delete File: path/to/old.txt
 *   *** Update File: path/to/existing.txt
 *   *** Move to: path/to/renamed.txt      (optional)
 *   @@ optional context header
 *    unchanged line
 *   -removed line
 *   +added line
 *   *** End Patch
 */
import fs from "node:fs";
import path from "node:path";

export interface Hunk {
  header: string | null;
  lines: { op: " " | "-" | "+"; text: string }[];
  endOfFile: boolean;
}

export type PatchOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo: string | null; hunks: Hunk[] };

export class PatchError extends Error {}

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // tolerate trailing newline and surrounding whitespace
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (lines[i]?.trim() !== "*** Begin Patch") throw new PatchError("patch must start with '*** Begin Patch'");
  i++;
  if (lines[lines.length - 1]?.trim() !== "*** End Patch") throw new PatchError("patch must end with '*** End Patch'");
  const end = lines.length - 1;

  const ops: PatchOp[] = [];
  while (i < end) {
    const line = lines[i]!;
    if (line.startsWith("*** Add File: ")) {
      const p = line.slice("*** Add File: ".length).trim();
      i++;
      const content: string[] = [];
      while (i < end && !lines[i]!.startsWith("*** ")) {
        const l = lines[i]!;
        if (!l.startsWith("+")) throw new PatchError(`Add File ${p}: every line must start with '+' (got: ${l})`);
        content.push(l.slice(1));
        i++;
      }
      ops.push({ type: "add", path: p, content: content.join("\n") + (content.length ? "\n" : "") });
    } else if (line.startsWith("*** Delete File: ")) {
      ops.push({ type: "delete", path: line.slice("*** Delete File: ".length).trim() });
      i++;
    } else if (line.startsWith("*** Update File: ")) {
      const p = line.slice("*** Update File: ".length).trim();
      i++;
      let moveTo: string | null = null;
      if (lines[i]?.startsWith("*** Move to: ")) {
        moveTo = lines[i]!.slice("*** Move to: ".length).trim();
        i++;
      }
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < end && !isFileMarker(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith("@@")) {
          const header = l.slice(2).trim();
          current = { header: header.length ? header : null, lines: [], endOfFile: false };
          hunks.push(current);
        } else if (l.trim() === "*** End of File") {
          if (current) current.endOfFile = true;
        } else {
          if (!current) {
            current = { header: null, lines: [], endOfFile: false };
            hunks.push(current);
          }
          const op = l[0];
          if (op === " " || op === "-" || op === "+") current.lines.push({ op, text: l.slice(1) });
          else if (l === "") current.lines.push({ op: " ", text: "" });
          else throw new PatchError(`Update File ${p}: unexpected line: ${l}`);
        }
        i++;
      }
      ops.push({ type: "update", path: p, moveTo, hunks });
    } else if (line.trim() === "") {
      i++;
    } else {
      throw new PatchError(`unexpected line in patch: ${line}`);
    }
  }
  return ops;
}

function isFileMarker(line: string): boolean {
  return line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ");
}

/** Applies hunks to file text in memory. Throws PatchError when context cannot be located. */
export function applyHunks(original: string, hunks: Hunk[], filename = "file"): string {
  const hadTrailingNewline = original.endsWith("\n");
  const fileLines = original.split("\n");
  if (hadTrailingNewline) fileLines.pop();
  let cursor = 0;
  for (const [hi, hunk] of hunks.entries()) {
    const oldLines = hunk.lines.filter((l) => l.op !== "+").map((l) => l.text);
    const newLines = hunk.lines.filter((l) => l.op !== "-").map((l) => l.text);
    let start = cursor;
    if (hunk.header) {
      const idx = findLine(fileLines, hunk.header, cursor);
      if (idx >= 0) start = idx;
    }
    let at: number;
    if (oldLines.length === 0) {
      // pure insertion: append at end of file (or after the header line when given)
      at = hunk.header && start !== cursor ? start + 1 : fileLines.length;
      fileLines.splice(at, 0, ...newLines);
      cursor = at + newLines.length;
      continue;
    }
    at = hunk.endOfFile ? findSequence(fileLines, oldLines, Math.max(0, fileLines.length - oldLines.length)) : findSequence(fileLines, oldLines, start);
    if (at < 0 && start !== 0) at = findSequence(fileLines, oldLines, 0);
    if (at < 0) throw new PatchError(`${filename}: could not find context for hunk ${hi + 1}:\n${oldLines.join("\n")}`);
    fileLines.splice(at, oldLines.length, ...newLines);
    cursor = at + newLines.length;
  }
  let out = fileLines.join("\n");
  if (hadTrailingNewline || original === "") out += "\n";
  return out;
}

function findLine(lines: string[], needle: string, from: number): number {
  for (let i = from; i < lines.length; i++) if (lines[i] === needle || lines[i]!.trim() === needle.trim()) return i;
  return -1;
}

function findSequence(lines: string[], seq: string[], from: number): number {
  const matchers: ((a: string, b: string) => boolean)[] = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ];
  for (const eq of matchers) {
    for (let i = from; i + seq.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < seq.length; j++) {
        if (!eq(lines[i + j]!, seq[j]!)) { ok = false; break; }
      }
      if (ok) return i;
    }
  }
  return -1;
}

export interface ApplyResult {
  summary: string[];
  /** Absolute paths touched (written or deleted). */
  touched: string[];
}

/** Applies a parsed patch to disk relative to `cwd`. `check(path)` may veto a write by throwing. */
export function applyPatchToDisk(ops: PatchOp[], cwd: string, check?: (absPath: string, op: PatchOp["type"]) => void): ApplyResult {
  const summary: string[] = [];
  const touched: string[] = [];
  // Validate everything first so a failing hunk leaves the tree untouched.
  const staged: { path: string; content: string | null; from?: string }[] = [];
  for (const op of ops) {
    const abs = path.resolve(cwd, op.path);
    check?.(abs, op.type);
    if (op.type === "add") {
      staged.push({ path: abs, content: op.content });
    } else if (op.type === "delete") {
      if (!fs.existsSync(abs)) throw new PatchError(`Delete File: ${op.path} does not exist`);
      staged.push({ path: abs, content: null });
    } else {
      if (!fs.existsSync(abs)) throw new PatchError(`Update File: ${op.path} does not exist`);
      const next = applyHunks(fs.readFileSync(abs, "utf8"), op.hunks, op.path);
      if (op.moveTo) {
        const dest = path.resolve(cwd, op.moveTo);
        check?.(dest, "add");
        staged.push({ path: abs, content: null });
        staged.push({ path: dest, content: next, from: abs });
      } else {
        staged.push({ path: abs, content: next });
      }
    }
  }
  for (const s of staged) {
    if (s.content === null) {
      fs.rmSync(s.path, { force: true });
      summary.push(`D ${path.relative(cwd, s.path)}`);
    } else {
      const existed = fs.existsSync(s.path);
      fs.mkdirSync(path.dirname(s.path), { recursive: true });
      fs.writeFileSync(s.path, s.content);
      summary.push(`${s.from ? "R" : existed ? "M" : "A"} ${path.relative(cwd, s.path)}`);
    }
    touched.push(s.path);
  }
  return { summary, touched };
}
