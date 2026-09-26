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
  test.fixme("rail 48px, sidebar 240px, 1px pane divider", async () => {
    const side = await box(tid(page, "sidebar"));
    expect(Math.round(side.x)).toBe(49);
    expect(Math.round(side.width)).toBe(240);
  });
});

test.describe("Phase 4 · composer", () => {
  test.fixme("composer box is ~736×98 and centered in the main pane", async () => {
    const c = await box(tid(page, "composer-box"));
    expect(Math.abs(c.width - 736)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.height - 98)).toBeLessThanOrEqual(2);
    expect(await css(tid(page, "composer-box"), "background-color")).toBe("rgb(38, 39, 41)"); // #262729
  });
});
