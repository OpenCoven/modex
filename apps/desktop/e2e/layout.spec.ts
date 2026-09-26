import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, items, launch, seedHome, tid } from "./support";

/**
 * Visual harness for the Codex-parity chat redesign.
 *
 * 1. Captures every named UI state at the reference window size (1786×1049, the size of the
 *    Codex screenshots the design is measured from) into `test-results/ui/<state>.png`, with a
 *    `manifest.json`. `npm run ui:compare -- <reference-dir>` pairs them with reference images.
 * 2. Holds the measured parity targets as geometry/computed-style assertions. Each phase of the
 *    redesign flips its block from `test.fixme` to `test` in the same PR that implements it, so
 *    parity is enforced by CI rather than by eye. Targets come from the reference screenshots
 *    (1× scale: macOS traffic lights measure their native 12 px).
 */
const REFERENCE = { width: 1786, height: 1049 };
const outDir = path.join(appDir, "test-results", "ui");

let app: ElectronApplication;
let page: Page;
const manifest: { state: string; file: string; viewport: { width: number; height: number } }[] = [];

async function capture(state: string): Promise<void> {
  // Let transitions (shimmer, spinners, focus rings) settle into a stable frame.
  await page.waitForTimeout(250);
  const file = path.join(outDir, `${state}.png`);
  await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
  manifest.push({ state, file: path.relative(outDir, file), viewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })) });
}

const box = async (l: Locator) => (await l.boundingBox())!;
const css = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { home } = seedHome();
  ({ app, page } = await launch(home));
  // Content size, not window size: the capture must match the reference pixel for pixel.
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), REFERENCE);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(REFERENCE.width);
});

test.afterAll(async () => {
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ reference: REFERENCE, states: manifest }, null, 2) + "\n");
  await app?.close();
});

test("captures every named chat state at the reference size", async () => {
  // MODEX_E2E opens the window with enableLargerThanScreen, so even a small CI display must give the full
  // reference size. Printed as well as asserted: the list reporter drops annotations.
  const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  console.log(`[ui:capture] viewport ${vp.width}×${vp.height} (reference ${REFERENCE.width}×${REFERENCE.height})`);
  expect(vp, "capture viewport must match the reference; the window was clamped to the display").toEqual(REFERENCE);

  await expect(tid(page, "empty-state")).toBeVisible();
  await capture("01-empty");

  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await capture("02-new-thread");

  await page.keyboard.type("Add a CONTRIBUTING.md with the three-step workflow");
  await capture("03-composer-typed");

  await page.keyboard.press("Meta+Enter");
  await expect(items(page, "approval").first()).toBeVisible();
  await capture("04-approval");

  await items(page, "approval").first().getByRole("button", { name: "Approve" }).click();
  await expect(tid(page, "thread-status")).toHaveAttribute("data-status", "idle");
  await expect(tid(page, "changes-file")).toHaveCount(1);
  await capture("05-turn-complete");

  await items(page, "thinking").first().locator('[data-testid="item-toggle"]').click();
  await items(page, "tool").filter({ hasText: "edit CONTRIBUTING.md" }).locator('[data-testid="item-toggle"]').click();
  await capture("06-items-expanded");

  await tid(page, "model-picker").click();
  await expect(tid(page, "model-menu")).toBeVisible();
  await capture("07-model-menu");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Meta+j");
  await expect(tid(page, "changes-panel")).toHaveCount(0);
  await capture("08-changes-hidden");

  expect(manifest.map((m) => m.state)).toEqual(["01-empty", "02-new-thread", "03-composer-typed", "04-approval", "05-turn-complete", "06-items-expanded", "07-model-menu", "08-changes-hidden"]);
});

// ── Parity targets. Flip each block on in the phase that implements it. ──────────────────────

test.describe("Phase 2 · tokens", () => {
  // Sampled from the 1× reference screenshots; coordinates in design/tokens.md. A change here is a design decision.
  const MEASURED: Record<string, string> = {
    "--bg-window": "#1b1b1c", "--bg-sidebar": "#131315", "--bg-main": "#0f0f11", "--bg-row-selected": "#222224",
    "--bg-composer": "#262729", "--bg-composer-context": "#151517", "--bg-user-bubble": "#1a1a1c",
    "--border-pane": "#2a2a2b", "--border-rail": "#1f1f21", "--border-composer": "#2b2c2e", "--rule": "#1f1f21",
    "--text-1": "#e3e4e6", "--text-2": "#c4c5c6", "--text-3": "#757577", "--text-4": "#5c5c5f", "--text-placeholder": "#535455",
    "--accent-warn": "#dc9258", "--text-sm": "13px", "--text-md": "14px", "--text-lg": "18px", "--text-xl": "28px",
    "--radius-row": "10px", "--radius-composer": "20px",
  };

  test("measured tokens resolve to their sampled values", async () => {
    const got = await page.evaluate((names) => {
      const cs = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
    }, Object.keys(MEASURED));
    expect(got).toEqual(MEASURED);
  });

  test("surface and text colors match the reference", async () => {
    expect(await css(page.locator("body"), "background-color")).toBe("rgb(15, 15, 17)"); // --bg-main #0f0f11
    expect(await css(page.locator("body"), "color")).toBe("rgb(227, 228, 230)"); // --text-1 #e3e4e6
    expect(await css(tid(page, "sidebar"), "background-color")).toBe("rgb(19, 19, 21)"); // --bg-sidebar #131315
  });
});

test.describe("Phase 3 · shell", () => {
  // Reference screenshot #1 (1×). ±1 px where anti-aliasing blurs an edge.
  const near = (got: number, want: number, tol = 1) => expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(tol);

  test("titlebar 42px, rail 48px, sheet with a 1px edge and 12px corners", async () => {
    const bar = await box(tid(page, "titlebar"));
    expect([bar.x, bar.y, bar.height]).toEqual([0, 0, 42]);
    expect(await css(tid(page, "titlebar"), "background-color")).toBe("rgb(27, 27, 28)"); // --bg-window #1b1b1c
    const rail = await box(tid(page, "rail"));
    expect([rail.x, rail.y, rail.width]).toEqual([0, 42, 48]);
    const sheet = await box(tid(page, "sheet"));
    expect([sheet.x, sheet.y]).toEqual([48, 42]);
    expect(await css(tid(page, "sheet"), "border-top-left-radius")).toBe("12px");
    expect(await css(tid(page, "sheet"), "border-left-color")).toBe("rgb(31, 31, 33)"); // --border-rail #1f1f21
  });

  test("sidebar x 49–288, divider at 289, main from 290", async () => {
    const side = await box(tid(page, "sidebar"));
    expect([side.x, side.y, side.width]).toEqual([49, 43, 240]);
    expect(await css(tid(page, "main"), "border-left-color")).toBe("rgb(42, 42, 43)"); // --border-pane #2a2a2b
    expect((await box(tid(page, "main"))).x).toBe(289);
  });

  test("titlebar nav buttons centred at x 99 / 133 / 167, y 20", async () => {
    for (const [id, cx] of [["nav-back", 99], ["nav-forward", 133], ["sidebar-toggle", 167]] as const) {
      const b = await box(tid(page, id));
      near(b.x + b.width / 2, cx);
      near(b.y + b.height / 2, 20);
    }
    const rail = await box(tid(page, "rail-chat"));
    expect([rail.x, rail.y, rail.width, rail.height]).toEqual([5, 51, 36, 36]);
    expect(await css(tid(page, "rail-chat"), "background-color")).toBe("rgb(41, 41, 42)"); // #29292a
  });

  test("sidebar header, New chat, Projects label and rows sit on the reference rhythm", async () => {
    const title = tid(page, "sidebar-title");
    expect(await css(title, "font-size")).toBe("18px");
    expect(await css(title, "font-weight")).toBe("600");
    const t = await box(title);
    near(t.x, 65);
    near(t.y + t.height / 2, 69);
    const chat = await box(tid(page, "new-chat"));
    expect([chat.x, chat.y, chat.height]).toEqual([57, 95, 30]);
    const project = await box(tid(page, "project-toggle").first());
    expect(project.y).toBe(166);
    const row = await box(tid(page, "thread-row").first());
    expect([row.x, row.y, row.width, row.height]).toEqual([57, 197, 213, 30]); // x 57–269, 31 px pitch from the project row
    expect(await css(tid(page, "thread-row").first(), "border-top-left-radius")).toBe("10px");
    const label = await box(tid(page, "thread-row-title").first());
    near(label.x, 89);
    expect(await css(tid(page, "thread-row-title").first(), "font-size")).toBe("14px");
  });
});

test.describe("Phase 4 · composer", () => {
  // Reference #1: box 736×98 at x 668–1403, y 931–1028; strip 38 px, inset 13 px; send a 34 px circle in the corner.
  const near = (got: number, want: number, tol = 1) => expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(tol);

  test("box is 736×98, centred in the main pane, 16 px off the bottom", async () => {
    const c = await box(tid(page, "composer-box"));
    near(c.x, 668); near(c.y, 931); near(c.width, 736); near(c.height, 98);
    const m = await box(tid(page, "main"));
    near(c.x + c.width / 2, m.x + 1 + (m.width - 1) / 2);
    expect(await css(tid(page, "composer-box"), "background-color")).toBe("rgb(38, 39, 41)"); // #262729
    expect(await css(tid(page, "composer-box"), "border-top-color")).toBe("rgb(43, 44, 46)"); // #2b2c2e
    expect(await css(tid(page, "composer-box"), "border-top-left-radius")).toBe("20px");
  });

  test("context strip sits on the box: 38 px, inset 13 px, #151517, 13 px text", async () => {
    const c = await box(tid(page, "composer-box"));
    const s = await box(tid(page, "composer-context"));
    near(s.x, c.x + 13); near(s.width, c.width - 26); expect(s.height).toBe(38); near(s.y + s.height, c.y);
    expect(await css(tid(page, "composer-context"), "background-color")).toBe("rgb(21, 21, 23)");
    expect(await css(tid(page, "composer-context"), "font-size")).toBe("13px");
  });

  test("control row: + at x 690, access pill after it, round send in the corner", async () => {
    const c = await box(tid(page, "composer-box"));
    const plus = await box(tid(page, "composer-plus"));
    near(plus.x + plus.width / 2, 690); near(plus.y + plus.height / 2, 1007);
    const access = await box(tid(page, "access-picker"));
    near(access.x, 708);
    expect(await css(tid(page, "access-picker"), "font-size")).toBe("13px");
    const send = await box(tid(page, "send"));
    expect([send.width, send.height]).toEqual([34, 34]);
    near(send.x + send.width, c.x + c.width - 2);
    near(send.y + send.height, c.y + c.height - 2);
    expect(await css(tid(page, "send"), "border-top-left-radius")).toBe("50%");
    expect(await css(tid(page, "composer-input"), "font-size")).toBe("14px");
    await expect(tid(page, "composer-input")).toHaveAttribute("placeholder", "Do anything");
  });
});
