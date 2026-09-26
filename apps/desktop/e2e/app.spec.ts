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
  // Backend lives in the composer's + menu; the mock thread shows Mock checked there.
  await tid(page, "composer-plus").click();
  await expect(tid(page, "backend-picker").getByRole("menuitemradio", { checked: true })).toHaveText("Mock");
  await page.keyboard.press("Escape");
  await expect(tid(page, "composer-plus-menu")).toHaveCount(0);
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
  // While a turn is in flight the composer offers Stop, not Send, and the access pill is locked.
  await expect(tid(page, "stop")).toBeVisible();
  await expect(tid(page, "send")).toHaveCount(0);
  await expect(tid(page, "access-picker")).toBeDisabled();
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
  await expect(tid(page, "plan-chip")).toBeVisible();
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
  await tid(page, "composer-plus").click();
  await expect(tid(page, "auto-toggle")).toHaveAttribute("aria-checked", "false");
  await expect(tid(page, "auto-indicator")).toHaveCount(0);
  await expect(tid(page, "auto-chip")).toHaveCount(0);
  await tid(page, "auto-toggle").click();
  await expect(tid(page, "composer-plus-menu")).toHaveCount(0);
  await expect(tid(page, "auto-chip")).toBeVisible();
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

test("primitives: the model Menu is keyboard-driven, and icon buttons are named, revealed on focus, and tooltipped", async () => {
  await expect(tid(page, "settings")).toHaveCount(0);
  // Its own thread, so the test also runs alone (-g).
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await expect(tid(page, "thread-status")).toHaveAttribute("data-status", "idle");

  // Menu: opening moves focus to the selected option; the trigger reports it is expanded.
  const picker = tid(page, "model-picker");
  await picker.click();
  await expect(picker).toHaveAttribute("aria-expanded", "true");
  const option = tid(page, "model-option").first();
  await expect(option).toBeFocused();
  // Arrow keys stay inside the list (one mock model: wraps onto itself); End/Home too.
  for (const key of ["ArrowDown", "ArrowUp", "End", "Home"]) {
    await page.keyboard.press(key);
    await expect(option).toBeFocused();
  }
  // Escape closes and hands focus back to the trigger.
  await page.keyboard.press("Escape");
  await expect(tid(page, "model-menu")).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  // Tab closes it too.
  await picker.click();
  await expect(option).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(tid(page, "model-menu")).toHaveCount(0);
  // A press outside closes it; a press on the trigger toggles it rather than counting as outside.
  await picker.click();
  await expect(tid(page, "model-menu")).toBeVisible();
  await tid(page, "transcript").click({ position: { x: 5, y: 5 } });
  await expect(tid(page, "model-menu")).toHaveCount(0);
  await picker.click();
  await picker.click();
  await expect(tid(page, "model-menu")).toHaveCount(0);
  // Enter on an option picks it; a model without efforts closes the menu.
  await picker.click();
  await page.keyboard.press("Enter");
  await expect(tid(page, "model-menu")).toHaveCount(0);
  await expect(picker).toHaveText(/Scripted mock/);

  // IconButton: an icon alone has no name, so every one carries an accessible label.
  const project = tid(page, "project").first();
  const newThread = tid(project, "project-new-thread");
  await expect(newThread).toHaveAccessibleName("New thread");
  await expect(tid(project, "project-new-worktree-thread")).toHaveAccessibleName("New thread in a git worktree");
  const more = tid(project, "project-menu");
  await expect(more).toHaveAccessibleName("Project actions");
  // Row actions are hidden until hover, but a keyboard user reaching one sees it, with its tooltip and shortcut.
  await expect(more).toHaveCSS("opacity", "0");
  await newThread.focus();
  await page.keyboard.press("Tab"); // → worktree
  await page.keyboard.press("Tab"); // → ⋯
  await expect(more).toBeFocused();
  await expect(more).toHaveCSS("opacity", "1");
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText("Project actions");
  await expect(more).toHaveAttribute("aria-describedby", (await tip.getAttribute("id"))!);
  // The ⋯ opens a Menu: focus lands on its item, Escape hands focus back.
  await page.keyboard.press("Enter");
  await expect(tid(project, "project-remove")).toBeFocused();
  await expect(tid(project, "project-remove")).toHaveRole("menuitem");
  await page.keyboard.press("Escape");
  await expect(tid(project, "project-remove")).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("tooltip")).toHaveText(/New thread in a git worktree\s*⇧⌘N/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  // Hover opens it after the delay.
  await page.mouse.move(900, 500);
  await newThread.hover();
  await expect(page.getByRole("tooltip")).toHaveText(/New thread\s*⌘N/);
  await page.mouse.move(900, 500);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("shell: back/forward, rename, search, show more, row menus, and a sidebar that stays hidden across a relaunch", async () => {
  const rows = tid(page, "thread-row");
  const current = page.locator('[data-testid="thread-row"][aria-current="true"]');
  const idOf = (l: typeof rows) => l.getAttribute("data-thread-id");

  // New chat (sidebar row) and ⌘N both open a thread in the current project; each becomes current.
  await tid(page, "new-chat").click();
  await expect(tid(page, "composer-input")).toBeFocused();
  const a = await idOf(current);
  await page.keyboard.press("Meta+n");
  await expect(current).not.toHaveAttribute("data-thread-id", a!);
  const b = await idOf(current);

  // Back / forward walk the selection history.
  await tid(page, "nav-back").click();
  await expect(current).toHaveAttribute("data-thread-id", a!);
  await expect(tid(page, "nav-forward")).toBeEnabled();
  await tid(page, "nav-forward").click();
  await expect(current).toHaveAttribute("data-thread-id", b!);
  await expect(tid(page, "nav-forward")).toBeDisabled();

  // Rename from the titlebar: read-only until double-clicked; Escape cancels, Enter saves.
  const title = tid(page, "thread-title");
  await expect(title).toHaveAttribute("readonly", "");
  await title.dblclick();
  await page.keyboard.type("Discarded name");
  await page.keyboard.press("Escape");
  await expect(title).toHaveValue("New thread");
  await title.dblclick();
  await page.keyboard.type("Shell rename check");
  await page.keyboard.press("Enter");
  await expect(title).toHaveAttribute("readonly", "");
  await expect(tid(current, "thread-row-title")).toHaveText("Shell rename check");

  // Search filters thread titles client-side; Escape restores the list.
  const total = await rows.count();
  await tid(page, "search-toggle").click();
  await expect(tid(page, "thread-search")).toBeFocused();
  await page.keyboard.type("rename CHECK");
  await expect(rows).toHaveCount(1);
  await page.keyboard.type("zzz");
  await expect(tid(page, "search-empty")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tid(page, "thread-search")).toHaveCount(0);
  await expect(rows).toHaveCount(total);

  // More than five threads in a project: five show, "Show more" expands, "Show less" folds back.
  while ((await tid(page, "thread-row").count()) < 5 || (await tid(page, "show-more").count()) === 0) {
    await page.keyboard.press("Meta+n");
    await expect(tid(page, "composer-input")).toBeFocused();
  }
  await expect(rows).toHaveCount(5);
  await tid(page, "show-more").click();
  await expect(tid(page, "show-more")).toHaveText("Show less");
  const all = await rows.count();
  expect(all).toBeGreaterThan(5);

  // Row ⋯ → Delete removes the thread; back skips entries for threads that no longer exist.
  const victim = rows.first();
  const victimId = await idOf(victim);
  await victim.hover();
  await tid(victim, "thread-menu").click();
  await tid(victim, "thread-delete").click();
  await expect(page.locator(`[data-testid="thread-row"][data-thread-id="${victimId}"]`)).toHaveCount(0);
  await expect(rows).toHaveCount(all - 1);

  // Clicking a project folds its threads away and back.
  const toggle = tid(page, "project-toggle").first();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(0);
  await toggle.click();
  await expect(rows).not.toHaveCount(0);

  // The sidebar toggle hides it, and the choice survives a relaunch.
  await tid(page, "sidebar-toggle").click();
  await expect(tid(page, "sidebar")).toHaveCount(0);
  await expect(tid(page, "sidebar-toggle")).toHaveAttribute("aria-pressed", "false");
  await app.close();
  ({ app, page } = await launch(home));
  await expect(tid(page, "rail")).toBeVisible();
  await expect(tid(page, "sidebar")).toHaveCount(0);
  await tid(page, "sidebar-toggle").click();
  await expect(tid(page, "sidebar")).toBeVisible();
});

test("composer: context strip, access menu, plan via + and its chip, send enabled only with text", async () => {
  await expect(tid(page, "sidebar")).toBeVisible(); // state loaded: shortcuts are live (the test also runs alone)
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();

  // Context strip: the project, where the thread runs, and the checkout's branch.
  await expect(tid(page, "context-project")).toHaveText(path.basename(repo));
  await expect(tid(page, "context-kind")).toHaveAttribute("data-kind", "local");
  await expect(tid(page, "context-kind")).toHaveText("Local");
  await expect(tid(page, "context-branch")).toHaveText("main");
  await expect(tid(page, "composer-context")).toHaveAttribute("title", repo);

  // Send is disabled until there is text.
  await expect(tid(page, "send")).toBeDisabled();
  await page.keyboard.type("hello");
  await expect(tid(page, "send")).toBeEnabled();
  await tid(page, "composer-input").fill("");
  await expect(tid(page, "send")).toBeDisabled();

  // Access pill = the thread's mode. Only full access is orange.
  const access = tid(page, "access-picker");
  await expect(access).toHaveAttribute("data-mode", "chat");
  await expect(access).toHaveText("Read only");
  await access.click();
  await expect(tid(page, "access-option")).toHaveCount(3);
  await expect(page.locator('[data-testid="access-option"][aria-checked="true"]')).toHaveAttribute("data-mode", "chat");
  await page.locator('[data-testid="access-option"][data-mode="full-access"]').click();
  await expect(tid(page, "access-menu")).toHaveCount(0);
  await expect(access).toHaveAttribute("data-mode", "full-access");
  await expect(access).toHaveText("Full access");
  await expect(access).toHaveCSS("color", "rgb(220, 146, 88)"); // --accent-warn #dc9258
  await access.click();
  await page.locator('[data-testid="access-option"][data-mode="chat"]').click();
  await expect(access).toHaveAttribute("data-mode", "chat");
  await expect(access).not.toHaveCSS("color", "rgb(220, 146, 88)");

  // + opens with focus on its first item (Plan mode); choosing it turns plan on and shows the chip.
  await tid(page, "composer-plus").click();
  await expect(tid(page, "plan-toggle")).toBeFocused();
  await expect(tid(page, "plan-toggle")).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Enter");
  await expect(tid(page, "composer-plus-menu")).toHaveCount(0);
  await expect(tid(page, "plan-chip")).toBeVisible();
  await expect(tid(page, "plan-indicator")).toBeVisible();
  await expect(tid(page, "composer-input")).toHaveAttribute("placeholder", /nothing will be edited/);
  await tid(page, "composer-plus").click();
  await expect(tid(page, "plan-toggle")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  // The chip turns it off again.
  await tid(page, "plan-chip").click();
  await expect(tid(page, "plan-chip")).toHaveCount(0);
  await expect(tid(page, "plan-indicator")).toHaveCount(0);
});
