import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as gitx from "../src/main/engine/git.js";
import { gitRepo, tmpdir } from "./helpers.js";

test("status/diff/revert over tracked, untracked and deleted files", async () => {
  const repo = gitRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "more\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "a\nb\n");
  fs.rmSync(path.join(repo, "package.json"));
  const snap = await gitx.status(repo);
  assert.equal(snap.isRepo, true);
  assert.equal(snap.branch, "main");
  assert.deepEqual(snap.files.map((f) => [f.path, f.code, f.additions, f.deletions]), [["README.md", " M", 1, 0], ["new.txt", "??", 2, 0], ["package.json", " D", 0, 3]]);
  assert.match(await gitx.diff(repo, "README.md"), /\+more/);
  assert.match(await gitx.diff(repo, "new.txt"), /\+a\n\+b/);
  await gitx.revert(repo, "new.txt");
  await gitx.revert(repo, "package.json");
  await gitx.revert(repo, "README.md");
  assert.deepEqual((await gitx.status(repo)).files, []);
  await assert.rejects(gitx.revert(repo, "../outside"), /outside the workspace/);
});

test("non-repo folders report isRepo=false", async () => {
  const snap = await gitx.status(tmpdir());
  assert.equal(snap.isRepo, false);
  assert.deepEqual(snap.files, []);
});

test("worktree add/remove", async () => {
  const repo = gitRepo();
  const dest = path.join(tmpdir(), "wt");
  const wt = await gitx.worktreeAdd(repo, dest, "modex/test");
  assert.equal(await gitx.currentBranch(dest), "modex/test");
  assert.equal(fs.existsSync(path.join(dest, "README.md")), true);
  await gitx.worktreeRemove(repo, wt.path);
  assert.equal(fs.existsSync(dest), false);
});
