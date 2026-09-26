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
      // HTTPS transport so a real `jev` on the machine's PATH never changes what the judge reports.
      settings: { default_backend: "mock", default_mode: "chat", default_model: { codex: "", claude: "", mock: "mock" }, claude_bin: "claude", codex_bin: "codex", mock_script: mockScript, routing: { jev_transport: "http" } },
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
  app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(os.tmpdir(), "modex-e2e-no-jev-config.json") } });
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
  // The header shows where the thread runs, with open/copy actions; a plain thread runs in the checkout itself.
  await expect(page.locator(".location .location-path")).toHaveAttribute("title", repo);
  await expect(page.locator(".location .location-branch")).toHaveCount(0);
  await expect(page.locator(".location button", { hasText: /Finder|Files/ })).toBeVisible();
  await expect(page.locator(".location button", { hasText: "Terminal" })).toBeVisible();
  await expect(page.locator(".location button", { hasText: "Copy path" })).toBeVisible();
  // Model picker is list-only (Codex behaviour): no free-text field, and the CLI's default model is preselected.
  await expect(page.locator(".composer input.model-input")).toHaveCount(0);
  await expect(page.locator(".model-trigger")).toHaveText(/Scripted mock/);
  await page.locator(".model-trigger").click();
  await expect(page.locator(".menu .menu-item")).toHaveCount(1);
  await expect(page.locator(".menu .menu-item.selected .menu-title")).toContainText("Scripted mock");
  await page.keyboard.press("Escape");
  await expect(page.locator(".menu")).toHaveCount(0);
  await page.locator(".composer textarea").focus();

  // Type a task and send with ⌘⏎.
  const prompt = "Add a CONTRIBUTING.md with the three-step workflow";
  await page.keyboard.type(prompt);
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".msg.user .bubble")).toHaveText(prompt);
  await expect(page.locator(".title-input")).toHaveValue(prompt);
  await expect(page.locator(".composer textarea")).toHaveValue("");

  // The scripted agent thinks first (collapsible), then streams text, runs tools, and pauses on the apply_patch approval.
  await expect(page.locator(".msg.assistant").first()).toContainText("take a look at the project");
  const thinking = page.locator(".thinking").first();
  await expect(thinking).toHaveClass(/done/);
  await expect(thinking.locator(".thinking-label")).toHaveText(/Thought for \d+s/);
  await expect(thinking.locator(".thinking-body")).toHaveCount(0, { timeout: 1000 });
  await thinking.locator(".thinking-head").click();
  await expect(thinking.locator(".thinking-body")).toContainText("inspect the repo layout");
  await thinking.locator(".thinking-head").click();
  await expect(thinking.locator(".thinking-body")).toHaveCount(0);
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

test("the transcript scrolls vertically inside its pane; the page itself never overflows", async () => {
  // Shrink the window so the finished conversation no longer fits.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 560));
  const transcript = page.locator(".transcript");
  await expect.poll(async () => transcript.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(50);
  await expect(transcript).toHaveCSS("overflow-y", "auto");
  // The document does not grow past the viewport (body is overflow:hidden; only panes scroll).
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  // Scrolling the pane moves it; the composer stays pinned at the bottom of the window.
  await transcript.evaluate((el) => el.scrollTo({ top: 0 }));
  await transcript.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect.poll(async () => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const composer = await page.locator(".composer").boundingBox();
  const inner = await page.evaluate(() => window.innerHeight);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(inner + 1);
  // Changes panel (⌘J to show it again) keeps its own scroll region too.
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".changes .diff")).toHaveCSS("overflow", "auto");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1380, 880));
});

test("⇧⌘N creates a worktree thread and the header shows its branch and path", async () => {
  await page.keyboard.press("Meta+Shift+n");
  await expect(page.locator(".threads .thread")).toHaveCount(2);
  const branch = page.locator(".location .location-branch");
  await expect(branch).toHaveText(/^modex\/\w+$/);
  const pathTitle = await page.locator(".location .location-path").getAttribute("title");
  expect(pathTitle).toContain(path.join(home, "worktrees"));
  expect(fs.existsSync(path.join(pathTitle!, "README.md"))).toBe(true);
  // Long paths are shortened from the left, keeping whole trailing segments and no stray separators.
  const shown = await page.locator(".location .location-path").innerText();
  expect(shown.startsWith("…") || shown === pathTitle).toBe(true);
  expect(pathTitle!.endsWith(shown.replace(/^…/, ""))).toBe(true);
  expect(shown.endsWith("/")).toBe(false);
  await expect(page.locator(".location .location-kind")).toHaveText("⑂");
  await page.locator(".location button", { hasText: "Copy path" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pathTitle);
  // Back to the first thread for the relaunch test.
  await page.locator(".threads .thread").nth(1).click();
  await expect(page.locator(".location .location-branch")).toHaveCount(0);
});

test("state survives a relaunch: the thread and its transcript are restored", async () => {
  await app.close();
  // MODEX_E2E keeps the secret store on the test cipher: CI runners have no unlocked keychain.
  app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(os.tmpdir(), "modex-e2e-no-jev-config.json") } });
  page = await app.firstWindow();
  await expect(page.locator(".threads .thread")).toHaveCount(2);
  await page.locator(".threads .thread").nth(1).click();
  await expect(page.locator(".approval .approval-answer")).toHaveText("Approved");
  await expect(page.locator(".msg.assistant").last()).toContainText("added CONTRIBUTING.md");
  await expect(page.locator(".pill.plan")).toHaveText(/Plan/);
});

test("⚡ Auto: the judge picks a model before the turn and leaves an expandable receipt", async () => {
  // A fresh thread (default mode: chat). No TypeSafe key in this environment, so the built-in heuristic judges.
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".threads .thread")).toHaveCount(3);
  await expect(page.locator(".btn.toggle.auto")).not.toHaveClass(/on/);
  await expect(page.locator(".pill.auto")).toHaveCount(0);
  await page.locator(".btn.toggle.auto").click();
  await expect(page.locator(".btn.toggle.auto")).toHaveClass(/on/);
  await expect(page.locator(".pill.auto")).toHaveText(/Auto/);
  await page.locator(".composer textarea").focus();
  await page.keyboard.type("What does this repo do?");
  await page.keyboard.press("Meta+Enter");
  const route = page.locator(".route").first();
  await expect(route).toBeVisible();
  await expect(route.locator(".route-label")).toContainText("Auto picked");
  await expect(route.locator(".route-label")).toContainText("Mock · mock");
  await expect(route.locator(".route-meta")).toContainText("quick answer · heuristic");
  await expect(route.locator(".route-body")).toHaveCount(0);
  await route.locator(".route-head").click();
  await expect(route.locator(".route-body")).toContainText("No TypeSafe API key found; used the built-in heuristic.");
  await expect(route.locator(".route-body")).toContainText("quick answer · complexity");
  await page.screenshot({ path: path.join(appDir, "test-results", "e2e-auto-route.png") });
  // The receipt sits between the user message and the agent's first reply.
  await expect(page.locator(".transcript > *").nth(0)).toHaveClass(/msg user/);
  await expect(page.locator(".transcript > *").nth(1)).toHaveClass(/route/);
  // Stop the scripted run; the Auto pill and the receipt survive.
  await page.keyboard.press("Meta+.");
  await expect(page.locator(".pill.status")).toHaveText("Idle");
  await expect(page.locator(".route")).toHaveCount(1);
  await expect(page.locator(".pill.auto")).toHaveText(/Auto/);
  // Settings explains why the heuristic judged, counts the auto turn, and exposes the policy knobs.
  await page.locator(".sidebar button", { hasText: "Settings" }).click();
  const status = page.locator("[data-testid=routing-status]");
  await expect(status).toContainText("No TypeSafe API key found");
  await expect(status).toContainText("1 auto turn so far");
  await expect(page.locator(".modal select").filter({ has: page.locator("option[value=economy]") })).toHaveValue("balanced");
  await page.locator(".modal button", { hasText: "Cancel" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
});

test("a key typed into Settings is kept encrypted outside state.json, reported masked, and can be cleared", async () => {
  await page.locator(".sidebar button", { hasText: "Settings" }).click();
  const keyBox = page.locator("[data-testid=jev-key]");
  await expect(keyBox.locator("input[type=password]")).toHaveAttribute("placeholder", /sk-…/);
  await expect(keyBox.locator("button", { hasText: "Clear" })).toBeDisabled();
  await keyBox.locator("input[type=password]").fill("sk-e2e-typed-key-4321");
  await keyBox.locator("button", { hasText: "Save key" }).click();
  const status = page.locator("[data-testid=routing-status]");
  await expect(status).toContainText("Jev configured");
  await expect(status).toContainText("key ****4321 from Modex keychain");
  await expect(keyBox.locator(".field > span")).toContainText("saved in test cipher (not secure)");
  await expect(keyBox.locator("input[type=password]")).toHaveValue("");
  // On disk: never in state.json, never in plaintext, and the secrets file is owner-only.
  expect(fs.readFileSync(path.join(home, "app", "state.json"), "utf8")).not.toContain("4321");
  const secretsFile = path.join(home, "app", "secrets.json");
  expect(fs.readFileSync(secretsFile, "utf8")).not.toContain("sk-e2e-typed-key-4321");
  expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
  await keyBox.locator("button", { hasText: "Clear" }).click();
  await expect(status).toContainText("No TypeSafe API key found");
  await expect(keyBox.locator("button", { hasText: "Clear" })).toBeDisabled();
  await page.locator(".modal button", { hasText: "Cancel" }).click();
});
