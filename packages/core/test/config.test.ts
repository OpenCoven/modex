import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyOverrides, defaultConfig, loadConfig, mergeConfig } from "../src/config.js";
import { tmpdir } from "./helpers.js";

test("applyOverrides parses JSON values and dotted provider keys; invalid enums throw", () => {
  const cfg = defaultConfig({ MODEX_HOME: "/tmp/h" });
  const out = applyOverrides(cfg, ['model="gpt-5"', "max_turns=3", "network_access=true", 'provider.base_url="http://localhost:11434/v1"', "approval_policy=never"]);
  assert.equal(out.model, "gpt-5");
  assert.equal(out.max_turns, 3);
  assert.equal(out.network_access, true);
  assert.equal(out.provider.base_url, "http://localhost:11434/v1");
  assert.equal(out.provider.name, "openai");
  assert.equal(out.approval_policy, "never");
  assert.throws(() => applyOverrides(cfg, ["sandbox_mode=yolo"]), /invalid sandbox_mode/);
  assert.throws(() => applyOverrides(cfg, ["nokey"]), /bad -c override/);
  // unknown keys are ignored, base is not mutated
  assert.equal(mergeConfig(cfg, { future_key: 1 }).model, cfg.model);
  assert.equal(cfg.model, "gpt-5-codex");
});

test("loadConfig layers ~/.modex/config.json and env overrides", () => {
  const home = tmpdir();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ model: "from-file", sandbox_mode: "read-only" }));
  const a = loadConfig({ MODEX_HOME: home });
  assert.equal(a.model, "from-file");
  assert.equal(a.sandbox_mode, "read-only");
  assert.equal(a.home, home);
  const b = loadConfig({ MODEX_HOME: home, MODEX_MODEL: "from-env", MODEX_MOCK_SCRIPT: "/x.json" });
  assert.equal(b.model, "from-env");
  assert.equal(b.provider.name, "mock");
  assert.equal(b.mock_script, "/x.json");
});
