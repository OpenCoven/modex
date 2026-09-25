import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Drives the real Electron window end to end with the keyboard, against the offline mock
 * backend so no CLI login is needed: ⌘N opens a thread, typing + ⌘⏎ sends, the scripted agent
 * pauses on an approval card, Approve resumes it, and the Changes panel shows the new file.
 */
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mockScript = path.join(appDir, "demo", "mock-script.json");

function seedHome(): { home: string; repo: string } {
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
      settings: { default_backend: "mock", default_mode: "chat", default_model: { codex: "", claude: "", mock: "mock" }, claude_bin: "claude", codex_bin: "codex", mock_script: mockScript },
    }),
  );
  return { home, repo };
}

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1" } });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
});

test("⌘N → type → ⌘⏎ → approve: the agent edits the repo and the UI shows every step", async () => {
  // Fresh home: one project, no threads → empty state.
  await expect(page.locator(".empty-card h1")).toHaveText("What are we building?");
  await expect(page.locator(".project-name")).toHaveText(path.basename(repo));

  // ⌘N creates a thread in the (only) project and focuses the composer.
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".thread-view")).toBeVisible();
  await expect(page.locator(".threads .thread")).toHaveCount(1);
  await expect(page.locator(".composer textarea")).toBeFocused();
  await expect(page.locator(".segmented button.on")).toHaveText("Mock");

  // Type a task and send with ⌘⏎.
  const prompt = "Add a CONTRIBUTING.md with the three-step workflow";
  await page.keyboard.type(prompt);
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".msg.user .bubble")).toHaveText(prompt);
  await expect(page.locator(".title-input")).toHaveValue(prompt);
  await expect(page.locator(".composer textarea")).toHaveValue("");

  // The scripted agent streams text, runs tools, then pauses on the apply_patch approval.
  await expect(page.locator(".msg.assistant").first()).toContainText("take a look at the project");
  await expect(page.locator(".tool .tool-title").filter({ hasText: "$ git status" })).toBeVisible();
  const card = page.locator(".approval").first();
  await expect(card).toBeVisible();
  await expect(card.locator(".approval-head")).toContainText("Allow add CONTRIBUTING.md?");
  await expect(page.locator(".pill.status")).toHaveText("Needs approval");
  await expect(page.locator(".dot.waiting")).toHaveCount(1);
  expect(fs.existsSync(path.join(repo, "CONTRIBUTING.md"))).toBe(false);

  // Approve → the patch lands, the turn completes, the sidebar dot goes idle.
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.locator(".approval-answer")).toHaveText("Approved");
  await expect(page.locator(".msg.assistant").last()).toContainText("added CONTRIBUTING.md");
  await expect(page.locator(".pill.status")).toHaveText("Idle");
  expect(fs.readFileSync(path.join(repo, "CONTRIBUTING.md"), "utf8")).toContain("# Contributing to Modex");

  // The Changes panel picked up the new file with its diff.
  await expect(page.locator(".changes .file-path")).toHaveText("CONTRIBUTING.md");
  await expect(page.locator(".changes .diff-body .add").first()).toContainText("# Contributing to Modex");

  // The tool item expands to show its output.
  await page.locator(".tool .tool-head").filter({ hasText: "edit CONTRIBUTING.md" }).click();
  await expect(page.locator(".tool-body .output")).toContainText("A CONTRIBUTING.md");

  // ⇧⌘P toggles plan mode; ⌘J hides the changes panel.
  await page.keyboard.press("Meta+Shift+p");
  await expect(page.locator(".btn.toggle.on")).toHaveText(/Plan/);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".changes")).toHaveCount(0);

  await page.screenshot({ path: path.join(appDir, "test-results", "e2e-final.png") });
});

test("state survives a relaunch: the thread and its transcript are restored", async () => {
  await app.close();
  app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...process.env, MODEX_HOME: home } });
  page = await app.firstWindow();
  await expect(page.locator(".threads .thread")).toHaveCount(1);
  await expect(page.locator(".approval .approval-answer")).toHaveText("Approved");
  await expect(page.locator(".msg.assistant").last()).toContainText("added CONTRIBUTING.md");
  await expect(page.locator(".pill.plan")).toHaveText(/Plan/);
});
