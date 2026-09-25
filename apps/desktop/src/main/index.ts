import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./engine/store.js";
import { ThreadRunner } from "./engine/runner.js";
import * as gitx from "./engine/git.js";
import { runDemo } from "./engine/demo.js";
import type { BridgeCommands, ThreadEvent } from "../shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
};

const demo = flag("demo");
const screenshotDir = flag("screenshot");
const home = demo ? fs.mkdtempSync(path.join(os.tmpdir(), "modex-demo-")) : process.env.MODEX_HOME ?? path.join(os.homedir(), ".modex");
fs.mkdirSync(home, { recursive: true });

const store = new Store(home);
let win: BrowserWindow | null = null;
const emit = (event: ThreadEvent): void => {
  win?.webContents.send("thread:event", event);
};
const runner = new ThreadRunner({ home, store, emit });

type Handler<K extends keyof BridgeCommands> = (req: BridgeCommands[K]["req"]) => Promise<BridgeCommands[K]["res"]> | BridgeCommands[K]["res"];
function handle<K extends keyof BridgeCommands>(channel: K, fn: Handler<K>): void {
  ipcMain.handle(channel, (_e, req) => fn(req as BridgeCommands[K]["req"]));
}

function cwdFor(threadId: string): string {
  const t = store.thread(threadId);
  if (!t) throw new Error(`unknown thread ${threadId}`);
  return t.cwd;
}

handle("state:get", () => ({ ...store.snapshot(), threads: store.snapshot().threads.map((t) => ({ ...t, status: runner.status(t.id) })) }));
handle("project:add", async (req) => {
  let dir = req?.path;
  if (!dir) {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: "Open a project folder" });
    if (r.canceled || !r.filePaths[0]) return null;
    dir = r.filePaths[0];
  }
  return store.addProject(dir);
});
handle("project:remove", ({ projectId }) => {
  for (const t of store.snapshot().threads.filter((t) => t.projectId === projectId)) runner.stop(t.id);
  store.removeProject(projectId);
  return store.snapshot();
});
handle("thread:create", ({ projectId, worktree, mode, model }) => runner.createThread(projectId, { worktree, mode, model }));
handle("thread:items", ({ threadId }) => runner.items(threadId));
handle("thread:send", async ({ threadId, text }) => {
  try {
    void runner.send(threadId, text).catch((err: Error) => emit({ threadId, type: "item", item: { id: `err-${Date.now()}`, kind: "notice", level: "error", text: err.message, at: new Date().toISOString() } }));
    // Give the runner a tick to reject synchronously-detectable problems (busy thread, missing cwd).
    await new Promise((r) => setTimeout(r, 0));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});
handle("thread:stop", ({ threadId }) => runner.stop(threadId));
handle("thread:answer", ({ threadId, itemId, answer }) => runner.answer(threadId, itemId, answer));
handle("thread:update", ({ threadId, patch }) => runner.updateThread(threadId, patch));
handle("thread:delete", async ({ threadId, removeWorktree }) => {
  await runner.deleteThread(threadId, removeWorktree);
  return store.snapshot();
});
handle("changes:status", ({ threadId }) => gitx.status(cwdFor(threadId)));
handle("changes:diff", ({ threadId, path: rel }) => gitx.diff(cwdFor(threadId), rel));
handle("changes:revert", async ({ threadId, path: rel }) => {
  const cwd = cwdFor(threadId);
  await gitx.revert(cwd, rel);
  return gitx.status(cwd);
});
handle("settings:update", (patch) => store.updateSettings(patch));
handle("env:has", ({ name }) => Boolean(process.env[name]));
handle("shell:openPath", async ({ path: p }) => {
  await shell.openPath(p);
});

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = "dark";
  const w = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: "Modex",
    backgroundColor: "#0f1013",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 16 },
    show: false,
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const devUrl = process.env.MODEX_DEV_URL;
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(path.join(here, "..", "..", "renderer", "index.html"));
  w.once("ready-to-show", () => w.show());
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  return w;
}

app.whenReady().then(async () => {
  win = createWindow();
  if (demo) {
    if (screenshotDir) setTimeout(() => { console.error("[modex] demo watchdog fired"); app.exit(2); }, 45_000).unref();
    await new Promise<void>((r) => win!.webContents.once("did-finish-load", () => r()));
    await runDemo({ store, runner, home, repoPath: path.resolve(here, "..", "..", "..", "..", ".."), screenshotDir, answer: flag("demo-answer"), capture: (name) => capture(name) });
    if (screenshotDir) app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || screenshotDir) app.quit();
});

async function capture(name: string): Promise<string> {
  if (!win || !screenshotDir) return "";
  fs.mkdirSync(screenshotDir, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(screenshotDir, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return file;
}
