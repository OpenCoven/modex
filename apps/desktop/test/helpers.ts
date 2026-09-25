import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { MockStep } from "@modex/core";

export function tmpdir(prefix = "modex-desktop-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A tiny git repo with one commit so worktrees and HEAD diffs work. */
export function gitRepo(): string {
  const dir = tmpdir("modex-repo-");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n\nline\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo" }, null, 2) + "\n");
  g("add", ".");
  g("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  return dir;
}

/** Writes a mock script to a temp file and returns its path. */
export function writeScript(steps: MockStep[]): string {
  const file = path.join(tmpdir("modex-script-"), "script.json");
  fs.writeFileSync(file, JSON.stringify({ steps }));
  return file;
}
