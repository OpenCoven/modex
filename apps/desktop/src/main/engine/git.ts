import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ChangedFile, ChangesSnapshot } from "../../shared/types.js";

export function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

export async function isRepo(cwd: string): Promise<boolean> {
  if (!fs.existsSync(cwd)) return false;
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function hasCommits(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "HEAD"])).code === 0;
}

/** Working-tree status relative to HEAD (staged + unstaged + untracked), with line counts. */
export async function status(cwd: string): Promise<ChangesSnapshot> {
  if (!(await isRepo(cwd))) return { cwd, isRepo: false, branch: null, files: [] };
  const branch = await currentBranch(cwd);
  const porcelain = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files: ChangedFile[] = [];
  const entries = porcelain.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    let p = e.slice(3);
    if (code[0] === "R" || code[0] === "C") {
      // renamed: "R  new\0old"
      i++;
    }
    files.push({ path: p, code, additions: 0, deletions: 0 });
  }
  if (await hasCommits(cwd)) {
    const numstat = await git(cwd, ["diff", "--numstat", "HEAD", "--"]);
    for (const line of numstat.stdout.split("\n")) {
      const [a, d, ...rest] = line.split("\t");
      const p = rest.join("\t");
      const f = files.find((f) => f.path === p);
      if (f) {
        f.additions = a === "-" ? 0 : Number(a);
        f.deletions = d === "-" ? 0 : Number(d);
      }
    }
  }
  for (const f of files) {
    if (f.code === "??") {
      const abs = path.join(cwd, f.path);
      try {
        f.additions = countLines(fs.readFileSync(abs, "utf8"));
      } catch {
        /* binary or unreadable */
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { cwd, isRepo: true, branch, files };
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}

/** Unified diff for one path; untracked files are rendered as pure additions. */
export async function diff(cwd: string, rel: string): Promise<string> {
  const st = await git(cwd, ["status", "--porcelain=v1", "--", rel]);
  const code = st.stdout.slice(0, 2);
  if (code === "??") {
    const r = await git(cwd, ["diff", "--no-index", "--", "/dev/null", rel]);
    return r.stdout;
  }
  const r = (await hasCommits(cwd)) ? await git(cwd, ["diff", "HEAD", "--", rel]) : await git(cwd, ["diff", "--cached", "--", rel]);
  return r.stdout;
}

/** Discards changes to one path (tracked → checkout from HEAD; untracked → delete). Destructive. */
export async function revert(cwd: string, rel: string): Promise<void> {
  const abs = path.resolve(cwd, rel);
  if (!abs.startsWith(path.resolve(cwd) + path.sep)) throw new Error(`refusing to revert outside the workspace: ${rel}`);
  const st = await git(cwd, ["status", "--porcelain=v1", "--", rel]);
  const code = st.stdout.slice(0, 2);
  if (code === "??") {
    fs.rmSync(abs, { force: true, recursive: false });
    return;
  }
  if (code[0] === "A") {
    await git(cwd, ["rm", "--cached", "-q", "--", rel]);
    fs.rmSync(abs, { force: true });
    return;
  }
  const r = await git(cwd, ["checkout", "HEAD", "--", rel]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git checkout failed for ${rel}`);
}

/** Creates a linked worktree on a fresh branch so a thread can work in isolation. */
export async function worktreeAdd(repo: string, dest: string, branch: string): Promise<{ path: string; branch: string }> {
  if (!(await hasCommits(repo))) throw new Error("the repository has no commits yet; worktrees need a HEAD");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await git(repo, ["worktree", "add", "-b", branch, dest, "HEAD"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git worktree add failed");
  return { path: dest, branch };
}

/** Removes a linked worktree (and its uncommitted changes). The branch is kept. */
export async function worktreeRemove(repo: string, dest: string): Promise<void> {
  const r = await git(repo, ["worktree", "remove", "--force", dest]);
  if (r.code !== 0 && fs.existsSync(dest)) throw new Error(r.stderr.trim() || "git worktree remove failed");
  await git(repo, ["worktree", "prune"]);
}
