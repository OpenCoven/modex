import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Shared setup for the Electron e2e specs. Specs select elements by `data-testid` and ARIA
 * state, never by CSS class, so the UI can be restyled without rewriting the tests.
 */
export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const mockScript = path.join(appDir, "demo", "mock-script.json");

/** A throwaway MODEX_HOME with one git project and no threads, on the offline mock backend in Chat mode. */
export function seedHome(): { home: string; repo: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-repo-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@modex.local", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@modex.local" };
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "e2e-repo", private: true }, null, 2) + "\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# e2e\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  execFileSync("git", ["add", "."], { cwd: repo, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"], { cwd: repo, env });
  fs.mkdirSync(path.join(home, "app", "threads"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "app", "state.json"),
    JSON.stringify({
      version: 1,
      projects: [{ id: "p1", name: path.basename(repo), path: repo, addedAt: new Date().toISOString() }],
      threads: [],
      // Chat mode is read-only, so the scripted apply_patch must be approved — that is the card we click.
      // HTTPS transport so a real `jev` on the machine's PATH never changes what the judge reports.
      settings: { default_backend: "mock", default_mode: "chat", default_model: { codex: "", claude: "", mock: "mock" }, claude_bin: "claude", codex_bin: "codex", mock_script: mockScript, routing: { jev_transport: "http" } },
    }),
  );
  return { home, repo };
}

/** Launches the built app against `home`. MODEX_E2E keeps the secret store on the test cipher: CI runners have no unlocked keychain. */
export async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(os.tmpdir(), "modex-e2e-no-jev-config.json") },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

/** `data-testid` lookup, scoped to a page or a parent locator. */
export const tid = (scope: Page | Locator, id: string): Locator => scope.locator(`[data-testid="${id}"]`);

/** Transcript items of one kind (`user`, `assistant`, `tool`, `approval`, `notice`, `thinking`, `route`). */
export const items = (page: Page, kind?: string): Locator =>
  page.locator(kind ? `[data-testid="item"][data-item-kind="${kind}"]` : `[data-testid="item"]`);

/**
 * New chats are drafts until their first send, so a test that needs a real thread sends one:
 * ⌘N (or ⇧⌘N for a worktree) → type → ⌘⏎, then stops the scripted turn once it has started.
 * Returns the new thread's id; it is selected and idle.
 */
export async function createThread(page: Page, prompt: string, opts: { worktree?: boolean } = {}): Promise<string> {
  await page.keyboard.press(opts.worktree ? "Meta+Shift+n" : "Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  if (opts.worktree) await expect(tid(page, "context-kind")).toHaveAttribute("data-kind", "worktree");
  await expect(tid(page, "composer-input")).toBeFocused();
  // fill, not type: this helper needs a thread, not keystroke realism (the main flow test types for real).
  await tid(page, "composer-input").fill(prompt);
  await page.keyboard.press("Meta+Enter");
  // The draft gives way to the new, selected thread. (Counting rows would not do: "Show more" caps them at five.)
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  await expect(tid(page, "draft-view")).toHaveCount(0);
  await expect(items(page, "user").first()).toHaveText(prompt);
  await page.keyboard.press("Meta+.");
  await expect(tid(page, "thread-status")).toHaveAttribute("data-status", "idle");
  return (await page.locator('[data-testid="thread-row"][aria-current="true"]').getAttribute("data-thread-id"))!;
}
