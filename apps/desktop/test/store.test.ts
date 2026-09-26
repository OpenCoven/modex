import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { tmpdir } from "./helpers.js";

test("store persists projects, threads, settings and items across instances", () => {
  const home = tmpdir("modex-home-");
  const a = new Store(home);
  const p = a.addProject(tmpdir("proj-"));
  assert.equal(a.addProject(p.path).id, p.id, "adding the same path twice is idempotent");
  a.addThread({ id: "t1", projectId: p.id, title: "x", createdAt: "now", updatedAt: "now", cwd: p.path, backend: "claude", mode: "agent", plan: false, model: "m", status: "running" });
  a.saveItems("t1", [{ id: "i1", kind: "user", text: "hi", at: "now" }]);
  a.updateSettings({ default_backend: "mock", mock_script: "/x.json" });
  const b = new Store(home);
  const s = b.snapshot();
  assert.equal(s.projects.length, 1);
  assert.equal(s.threads[0]?.status, "idle", "running threads reset to idle on restart");
  assert.equal(s.settings.default_backend, "mock");
  assert.equal(s.settings.codex_bin, "codex");
  assert.equal(s.threads[0]?.backend, "claude");
  assert.equal(b.items("t1").length, 1);
  b.removeProject(p.id);
  assert.deepEqual(new Store(home).snapshot().threads, []);
  assert.deepEqual(new Store(home).items("t1"), []);
});

test("migrateSettings accepts the pre-0.3 API-era settings shape", async () => {
  const { migrateSettings } = await import("../src/main/engine/store.js");
  const m = migrateSettings({ provider: "openai", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY", default_model: "gpt-5-codex", default_mode: "chat" });
  assert.equal(m.default_backend, "codex");
  assert.equal(m.default_mode, "chat");
  assert.deepEqual(m.default_model, { codex: "", claude: "", mock: "mock" });
  assert.equal("provider" in m, false);
  assert.deepEqual([m.routing.jev_transport, m.routing.jev_bin, m.routing.posture], ["auto", "jev", "balanced"]);
  const r = migrateSettings({ routing: { jev_transport: "cli", jev_bin: " /opt/jev ", posture: "quality", premium_turns_per_day: 3.7, min_confidence: 2 } }).routing;
  assert.deepEqual([r.jev_transport, r.jev_bin, r.posture, r.premium_turns_per_day, r.min_confidence], ["cli", "/opt/jev", "quality", 3, 0.6]);
});
