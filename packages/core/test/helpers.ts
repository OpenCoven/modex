import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UI } from "../src/ui.js";
import type { ModexConfig } from "../src/types.js";
import { defaultConfig } from "../src/config.js";

export function tmpdir(prefix = "modex-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(home: string, patch: Partial<ModexConfig> = {}): ModexConfig {
  return { ...defaultConfig({ MODEX_HOME: home }), provider: { name: "mock", base_url: "", api_key_env: "" }, max_turns: 8, shell_timeout_ms: 10_000, ...patch };
}

export interface RecordedUI extends UI {
  log: string[];
  confirms: string[];
}

/** UI that records everything and answers confirms from a queue (default "no"). */
export function recordedUI(answers: ("yes" | "no" | "always")[] = []): RecordedUI {
  const queue = [...answers];
  const ui: RecordedUI = {
    log: [],
    confirms: [],
    info: (m) => ui.log.push(`info:${m}`),
    assistant: (m) => ui.log.push(`assistant:${m}`),
    tool: (t, b) => ui.log.push(`tool:${t}${b ? `\n${b}` : ""}`),
    warn: (m) => ui.log.push(`warn:${m}`),
    error: (m) => ui.log.push(`error:${m}`),
    async confirm(q) {
      ui.confirms.push(q);
      return queue.shift() ?? "no";
    },
    async prompt() {
      return null;
    },
    close() {},
  };
  return ui;
}
