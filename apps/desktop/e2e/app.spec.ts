import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, items, launch, seedHome, tid } from "./support";

/**
 * Drives the real Electron window end to end with the keyboard, against the offline mock
 * backend so no CLI login is needed: ⌘N opens a thread, typing + ⌘⏎ sends, the scripted agent
 * pauses on an approval card, Approve resumes it, and the Changes panel shows the new file.
 *
 * Selectors are `data-testid` + ARIA state only (see ./support.ts), so restyling never breaks them.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
});

test.afterAll(async () => {
  await app?.close();
});

test("⌘N → type → ⌘⏎ → approve: the agent edits the repo and the UI shows every step", async () => {
  // Fresh home: one project, no threads → empty state.
  await expect(tid(page, "empty-title")).toHaveText("What are we building?");
  await expect(tid(page, "project-name")).toHaveText(path.basename(repo));

  // ⌘N creates a thread in the (only) project and focuses the composer.
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "thread-view")).toBeVisible();
  await expect(tid(page, "thread-row")).toHaveCount(1);
  await expect(tid(page, "composer-input")).toBeFocused();
  await expect(tid(page, "backend-picker").getByRole("radio", { checked: true })).toHaveText("Mock");
  // The header shows where the thread runs, with open/copy actions; a plain thread runs in the checkout itself.
  await expect(tid(page, "location-path")).toHaveAttribute("title", repo);
  await expect(tid(page, "location-branch")).toHaveCount(0);
  await expect(tid(page, "action-open-folder")).toBeVisible();
  await expect(tid(page, "action-open-terminal")).toBeVisible();
  await expect(tid(page, "action-copy-path")).toBeVisible();
  // Model picker is list-only (Codex behaviour): no free-text field, and the CLI's default model is preselected.
  await expect(tid(page, "composer").locator("input")).toHaveCount(0);
  await expect(tid(page, "model-picker")).toHaveText(/Scripted mock/);
  await tid(page, "model-picker").click();
  await expect(tid(page, "model-option")).toHaveCount(1);
  await expect(tid(page, "model-menu").locator('[data-testid="model-option"][aria-selected="true"] [data-testid="model-option-title"]')).toContainText("Scripted mock");
  await page.keyboard.press("Escape");
  await expect(tid(page, "model-menu")).toHaveCount(0);
  await tid(page, "composer-input").focus();

  // Type a task and send with ⌘⏎.
  const prompt = "Add a CONTRIBUTING.md with the three-step workflow";
  await page.keyboard.type(prompt);
  await page.keyboard.press("Meta+Enter");
  await expect(items(page, "user").locator('[data-testid="item-text"]')).toHaveText(prompt);
  await expect(tid(page, "thread-title")).toHaveValue(prompt);
  await expect(tid(page, "composer-input")).toHaveValue("");

  // The scripted agent thinks first (collapsible), then streams text, runs tools, and pauses on the apply_patch approval.
  await expect(items(page, "assistant").first()).toContainText("take a look at the project");
  const thinking = items(page, "thinking").first();
  await expect(thinking).toHaveAttribute("data-status", "done");
  await expect(tid(thinking, "thinking-label")).toHaveText(/Thought for \d+s/);
  await expect(tid(thinking, "item-body")).toHaveCount(0, { timeout: 1000 });
  await tid(thinking, "item-toggle").click();
  await expect(tid(thinking, "item-body")).toContainText("inspect the repo layout");
  await tid(thinking, "item-toggle").click();
  await expect(tid(thinking, "item-body")).toHaveCount(0);
  await expect(tid(page, "tool-title").filter({ hasText: "$ git status" })).toBeVisible();
  const card = items(page, "approval").first();
  await expect(card).toBeVisible();
  await expect(tid(card, "approval-question")).toContainText("Allow add CONTRIBUTING.md?");
  await expect(tid(page, "thread-status")).toHaveText("Needs approval");
  await expect(page.locator('[data-testid="thread-row"][data-status="waiting"]')).toHaveCount(1);
  expect(fs.existsSync(path.join(repo, "CONTRIBUTING.md"))).toBe(false);

  // Approve → the patch lands, the turn completes, the sidebar dot goes idle.
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(tid(card, "approval-answer")).toHaveText("Approved");
  await expect(items(page, "assistant").last()).toContainText("added CONTRIBUTING.md");
  await expect(tid(page, "thread-status")).toHaveText("Idle");
  expect(fs.readFileSync(path.join(repo, "CONTRIBUTING.md"), "utf8")).toContain("# Contributing to Modex");

  // The Changes panel picked up the new file with its diff.
  await expect(tid(page, "changes-file-path")).toHaveText("CONTRIBUTING.md");
  await expect(tid(page, "diff").locator('[data-line="add"]').first()).toContainText("# Contributing to Modex");

  // The tool item expands to show its output.
  await items(page, "tool").filter({ hasText: "edit CONTRIBUTING.md" }).locator('[data-testid="item-toggle"]').click();
  await expect(tid(page, "tool-output")).toContainText("A CONTRIBUTING.md");

  // ⇧⌘P toggles plan mode; ⌘J hides the changes panel.
  await page.keyboard.press("Meta+Shift+p");
  await expect(tid(page, "plan-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Meta+j");
  await expect(tid(page, "changes-panel")).toHaveCount(0);

  await page.screenshot({ path: path.join(appDir, "test-results", "e2e-final.png") });
});

test("the transcript scrolls vertically inside its pane; the page itself never overflows", async () => {
  // Shrink the window so the finished conversation no longer fits.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 560));
  const transcript = tid(page, "transcript");
  await expect.poll(async () => transcript.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(50);
  await expect(transcript).toHaveCSS("overflow-y", "auto");
  // The document does not grow past the viewport (body is overflow:hidden; only panes scroll).
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  // Scrolling the pane moves it; the composer stays pinned at the bottom of the window.
  await transcript.evaluate((el) => el.scrollTo({ top: 0 }));
  await transcript.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect.poll(async () => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const composer = await tid(page, "composer").boundingBox();
  const inner = await page.evaluate(() => window.innerHeight);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(inner + 1);
  // Changes panel (⌘J to show it again) keeps its own scroll region too.
  await page.keyboard.press("Meta+j");
  await expect(tid(page, "changes-diff")).toHaveCSS("overflow", "auto");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1380, 880));
});

test("⇧⌘N creates a worktree thread and the header shows its branch and path", async () => {
  await page.keyboard.press("Meta+Shift+n");
  await expect(tid(page, "thread-row")).toHaveCount(2);
  const branch = tid(page, "location-branch");
  await expect(branch).toHaveText(/^modex\/\w+$/);
  const pathTitle = await tid(page, "location-path").getAttribute("title");
  expect(pathTitle).toContain(path.join(home, "worktrees"));
  expect(fs.existsSync(path.join(pathTitle!, "README.md"))).toBe(true);
  // Long paths are shortened from the left, keeping whole trailing segments and no stray separators.
  const shown = await tid(page, "location-path").innerText();
  expect(shown.startsWith("…") || shown === pathTitle).toBe(true);
  expect(pathTitle!.endsWith(shown.replace(/^…/, ""))).toBe(true);
  expect(shown.endsWith("/")).toBe(false);
  await expect(tid(page, "location-kind")).toHaveText("⑂");
  await tid(page, "action-copy-path").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pathTitle);
  // Back to the first thread for the relaunch test.
  await tid(page, "thread-row").nth(1).click();
  await expect(tid(page, "location-branch")).toHaveCount(0);
});

test("state survives a relaunch: the thread and its transcript are restored", async () => {
  await app.close();
  ({ app, page } = await launch(home));
  await expect(tid(page, "thread-row")).toHaveCount(2);
  await tid(page, "thread-row").nth(1).click();
  await expect(items(page, "approval").locator('[data-testid="approval-answer"]')).toHaveText("Approved");
  await expect(items(page, "assistant").last()).toContainText("added CONTRIBUTING.md");
  await expect(tid(page, "plan-indicator")).toHaveText(/Plan/);
});

test("⚡ Auto: the judge picks a model before the turn and leaves an expandable receipt", async () => {
  // A fresh thread (default mode: chat). No TypeSafe key in this environment, so the built-in heuristic judges.
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "thread-row")).toHaveCount(3);
  await expect(tid(page, "auto-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(tid(page, "auto-indicator")).toHaveCount(0);
  await tid(page, "auto-toggle").click();
  await expect(tid(page, "auto-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(tid(page, "auto-indicator")).toHaveText(/Auto/);
  await tid(page, "composer-input").focus();
  await page.keyboard.type("What does this repo do?");
  await page.keyboard.press("Meta+Enter");
  const route = items(page, "route").first();
  await expect(route).toBeVisible();
  await expect(tid(route, "route-label")).toContainText("Auto picked");
  await expect(tid(route, "route-label")).toContainText("Mock · mock");
  await expect(tid(route, "route-meta")).toContainText("quick answer · heuristic");
  await expect(tid(route, "item-body")).toHaveCount(0);
  await tid(route, "item-toggle").click();
  await expect(tid(route, "item-body")).toContainText("No TypeSafe API key found; used the built-in heuristic.");
  await expect(tid(route, "item-body")).toContainText("quick answer · complexity");
  await page.screenshot({ path: path.join(appDir, "test-results", "e2e-auto-route.png") });
  // The receipt sits between the user message and the agent's first reply.
  await expect(items(page).nth(0)).toHaveAttribute("data-item-kind", "user");
  await expect(items(page).nth(1)).toHaveAttribute("data-item-kind", "route");
  // Stop the scripted run; the Auto pill and the receipt survive.
  await page.keyboard.press("Meta+.");
  await expect(tid(page, "thread-status")).toHaveText("Idle");
  await expect(items(page, "route")).toHaveCount(1);
  await expect(tid(page, "auto-indicator")).toHaveText(/Auto/);
  // Settings explains why the heuristic judged, counts the auto turn, and exposes the policy knobs.
  await tid(page, "open-settings").click();
  const status = tid(page, "routing-status");
  await expect(status).toContainText("No TypeSafe API key found");
  await expect(status).toContainText("1 auto turn so far");
  await expect(tid(page, "routing-posture")).toHaveValue("balanced");
  await tid(page, "settings").getByRole("button", { name: "Cancel" }).click();
  await expect(tid(page, "settings")).toHaveCount(0);
});

test("a key typed into Settings is kept encrypted outside state.json, reported masked, and can be cleared", async () => {
  await tid(page, "open-settings").click();
  const keyBox = tid(page, "jev-key");
  await expect(keyBox.locator("input[type=password]")).toHaveAttribute("placeholder", /sk-…/);
  await expect(keyBox.getByRole("button", { name: "Clear" })).toBeDisabled();
  await keyBox.locator("input[type=password]").fill("sk-e2e-typed-key-4321");
  await keyBox.getByRole("button", { name: "Save key" }).click();
  const status = tid(page, "routing-status");
  await expect(status).toContainText("Jev configured");
  await expect(status).toContainText("key ****4321 from Modex keychain");
  await expect(keyBox.locator("label > span").first()).toContainText("saved in test cipher (not secure)");
  await expect(keyBox.locator("input[type=password]")).toHaveValue("");
  // On disk: never in state.json, never in plaintext, and the secrets file is owner-only.
  expect(fs.readFileSync(path.join(home, "app", "state.json"), "utf8")).not.toContain("4321");
  const secretsFile = path.join(home, "app", "secrets.json");
  expect(fs.readFileSync(secretsFile, "utf8")).not.toContain("sk-e2e-typed-key-4321");
  expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
  await keyBox.getByRole("button", { name: "Clear" }).click();
  await expect(status).toContainText("No TypeSafe API key found");
  await expect(keyBox.getByRole("button", { name: "Clear" })).toBeDisabled();
  await tid(page, "settings").getByRole("button", { name: "Cancel" }).click();
});
