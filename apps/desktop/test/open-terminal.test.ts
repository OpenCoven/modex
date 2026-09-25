import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalCommand } from "../src/main/engine/open-terminal.js";

test("terminalCommand opens the platform terminal at the directory", () => {
  assert.deepEqual(terminalCommand("darwin", "/w/repo"), { file: "open", args: ["-a", "Terminal", "/w/repo"] });
  assert.deepEqual(terminalCommand("linux", "/w/repo"), { file: "x-terminal-emulator", args: ["--working-directory=/w/repo"] });
  const win = terminalCommand("win32", "C:\\w\\repo");
  assert.equal(win.file, "cmd.exe");
  assert.ok(win.args.join(" ").includes('cd /d "C:\\w\\repo"'));
});
