import fs from "node:fs";
import path from "node:path";

const INSTRUCTION_FILES = ["AGENTS.md", "AGENTS.override.md"];
const MAX_BYTES = 32 * 1024;

export interface InstructionSource {
  path: string;
  content: string;
}

/** Finds the enclosing git root for `cwd`, or null. */
export function findGitRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Codex-style instruction discovery: the global ~/.modex/AGENTS.md first, then every
 * AGENTS.md from the project root down to the current directory, in order. AGENTS.override.md
 * takes precedence over AGENTS.md in the same directory.
 */
export function discoverInstructions(cwd: string, home: string): InstructionSource[] {
  const out: InstructionSource[] = [];
  const global = path.join(home, "AGENTS.md");
  if (fs.existsSync(global)) out.push(read(global));

  const root = findGitRoot(cwd) ?? path.resolve(cwd);
  const rel = path.relative(root, path.resolve(cwd));
  const segments = rel ? rel.split(path.sep) : [];
  const dirs = [root];
  for (const seg of segments) dirs.push(path.join(dirs[dirs.length - 1]!, seg));
  for (const dir of dirs) {
    const override = path.join(dir, INSTRUCTION_FILES[1]!);
    const primary = path.join(dir, INSTRUCTION_FILES[0]!);
    if (fs.existsSync(override)) out.push(read(override));
    else if (fs.existsSync(primary)) out.push(read(primary));
  }
  return out;
}

function read(file: string): InstructionSource {
  let content = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(content) > MAX_BYTES) content = content.slice(0, MAX_BYTES) + "\n[truncated]";
  return { path: file, content: content.trim() };
}

export function renderInstructions(sources: InstructionSource[]): string {
  if (sources.length === 0) return "";
  return sources.map((s) => `<instructions path="${s.path}">\n${s.content}\n</instructions>`).join("\n\n");
}
