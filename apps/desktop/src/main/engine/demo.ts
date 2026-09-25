import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Store } from "./store.js";
import type { ThreadRunner } from "./runner.js";

export interface DemoOptions {
  store: Store;
  runner: ThreadRunner;
  home: string;
  /** Repository to demo against (a temp copy is made so nothing real is modified). */
  repoPath: string;
  screenshotDir?: string;
  /** "yes" | "no" — auto-answer the approval so the transcript completes. Unset leaves the card waiting. */
  answer?: string;
  capture: (name: string) => Promise<string>;
}

/**
 * `electron . --demo [--screenshot=DIR] [--demo-answer=yes]`
 * Seeds a throwaway MODEX_HOME with the repo as a project, runs the scripted mock provider in
 * Chat mode so an approval card appears, optionally answers it, and captures screenshots.
 * This is how the UI is verified without a model API key.
 */
export async function runDemo(o: DemoOptions): Promise<void> {
  const demoRepo = path.join(o.home, "demo-repo");
  copyRepoForDemo(o.repoPath, demoRepo);
  const script = path.resolve(o.repoPath, "apps", "desktop", "demo", "mock-script.json");
  o.store.updateSettings({ default_backend: "mock", mock_script: script, default_mode: "chat" });
  const project = o.store.addProject(demoRepo);
  // A second, finished thread so the sidebar shows history.
  const earlier = await o.runner.createThread(project.id, { mode: "agent", backend: "mock" });
  o.runner.updateThread(earlier.id, { title: "Explain the approval policy module" });
  const thread = await o.runner.createThread(project.id, { mode: "chat", backend: "mock" });
  const turn = o.runner.send(thread.id, "Add a CONTRIBUTING.md with the three-step workflow (install, test, PR).");
  await waitFor(() => o.runner.status(thread.id) === "waiting" || o.runner.status(thread.id) === "idle" || o.runner.status(thread.id) === "error");
  await settle();
  await o.capture("01-thread-approval");
  if (o.answer === "yes" || o.answer === "no") {
    const approval = o.runner.items(thread.id).find((i) => i.kind === "approval");
    if (approval) o.runner.answer(thread.id, approval.id, o.answer);
    await turn;
    await settle(700);
    await o.capture("02-thread-complete");
  }
}

function copyRepoForDemo(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["package.json", "README.md", "LICENSE", ".gitignore", "tsconfig.base.json"]) {
    const from = path.join(src, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, name));
  }
  for (const dir of ["packages/core/src", "packages/cli"]) {
    const from = path.join(src, dir);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, dir), { recursive: true, filter: (p) => !/node_modules|dist/.test(p) });
  }
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "modex-demo", GIT_AUTHOR_EMAIL: "demo@modex.local", GIT_COMMITTER_NAME: "modex-demo", GIT_COMMITTER_EMAIL: "demo@modex.local" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dest, env });
    execFileSync("git", ["add", "."], { cwd: dest, env });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "demo baseline"], { cwd: dest, env });
  } catch {
    /* git optional for the demo */
  }
}

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function settle(ms = 500): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
