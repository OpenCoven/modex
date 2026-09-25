import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { tmpdir } from "./helpers.js";

test("store persists projects, threads, settings and items across instances", () => {
  const home = tmpdir("modex-home-");
  const a = new Store(home);
  const p = a.addProject(tmpdir("proj-"));
  assert.equal(a.addProject(p.path).id, p.id, "adding the same path twice is idempotent");
  a.addThread({ id: "t1", projectId: p.id, title: "x", createdAt: "now", updatedAt: "now", cwd: p.path, mode: "agent", model: "m", status: "running" });
  a.saveItems("t1", [{ id: "i1", kind: "user", text: "hi", at: "now" }]);
  a.updateSettings({ provider: "mock", mock_script: "/x.json" });
  const b = new Store(home);
  const s = b.snapshot();
  assert.equal(s.projects.length, 1);
  assert.equal(s.threads[0]?.status, "idle", "running threads reset to idle on restart");
  assert.equal(s.settings.provider, "mock");
  assert.equal(s.settings.default_model, "gpt-5-codex");
  assert.equal(b.items("t1").length, 1);
  b.removeProject(p.id);
  assert.deepEqual(new Store(home).snapshot().threads, []);
  assert.deepEqual(new Store(home).items("t1"), []);
});
