import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parsePatch, applyHunks, applyPatchToDisk, PatchError } from "../src/tools/apply_patch.js";
import { tmpdir } from "./helpers.js";

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch\n`;

test("parsePatch: add, delete, update with move", () => {
  const ops = parsePatch(patch(["*** Add File: a.txt", "+hello", "+world", "*** Delete File: old.txt", "*** Update File: src/x.ts", "*** Move to: src/y.ts", "@@ function f", " const a = 1;", "-const b = 2;", "+const b = 3;"].join("\n")));
  assert.equal(ops.length, 3);
  assert.deepEqual(ops[0], { type: "add", path: "a.txt", content: "hello\nworld\n" });
  assert.deepEqual(ops[1], { type: "delete", path: "old.txt" });
  const up = ops[2]!;
  assert.equal(up.type, "update");
  if (up.type !== "update") return;
  assert.equal(up.moveTo, "src/y.ts");
  assert.equal(up.hunks[0]!.header, "function f");
  assert.deepEqual(up.hunks[0]!.lines.map((l) => l.op), [" ", "-", "+"]);
});

test("parsePatch: rejects malformed patches", () => {
  assert.throws(() => parsePatch("*** Add File: a\n+x"), PatchError);
  assert.throws(() => parsePatch(patch("*** Add File: a\nno plus")), PatchError);
  assert.throws(() => parsePatch(patch("garbage")), PatchError);
});

test("applyHunks: replaces by context, tolerates whitespace drift, preserves trailing newline", () => {
  const original = "line1\nline2\nline3\n";
  const [op] = parsePatch(patch("*** Update File: f\n line1\n-line2\n+LINE2\n line3"));
  if (op?.type !== "update") throw new Error("expected update");
  assert.equal(applyHunks(original, op.hunks), "line1\nLINE2\nline3\n");
  // context with trailing whitespace drift still matches (context is normalised to the patch's text)
  assert.equal(applyHunks("line1  \nline2\nline3\n", op.hunks), "line1\nLINE2\nline3\n");
  // missing context fails loudly
  assert.throws(() => applyHunks("a\nb\nc\n", op.hunks), /could not find context/);
});

test("applyHunks: end-of-file anchored hunk and pure insertion", () => {
  const [eof] = parsePatch(patch("*** Update File: f\n@@\n-end\n+END\n*** End of File"));
  if (eof?.type !== "update") throw new Error("expected update");
  assert.equal(applyHunks("end\nmiddle\nend\n", eof.hunks), "end\nmiddle\nEND\n");
  const [ins] = parsePatch(patch("*** Update File: f\n+appended"));
  if (ins?.type !== "update") throw new Error("expected update");
  assert.equal(applyHunks("a\n", ins.hunks), "a\nappended\n");
});

test("applyPatchToDisk: atomic validation, add/update/move/delete", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "keep.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "gone.txt"), "bye\n");
  const ops = parsePatch(patch(["*** Add File: new/deep/file.md", "+# hi", "*** Update File: keep.txt", "*** Move to: moved.txt", " one", "-two", "+TWO", "*** Delete File: gone.txt"].join("\n")));
  const { summary, touched } = applyPatchToDisk(ops, dir);
  assert.equal(fs.readFileSync(path.join(dir, "new/deep/file.md"), "utf8"), "# hi\n");
  assert.equal(fs.existsSync(path.join(dir, "keep.txt")), false);
  assert.equal(fs.readFileSync(path.join(dir, "moved.txt"), "utf8"), "one\nTWO\n");
  assert.equal(fs.existsSync(path.join(dir, "gone.txt")), false);
  assert.ok(summary.some((s) => s.startsWith("A ")));
  assert.ok(touched.length >= 3);

  // A failing hunk anywhere leaves the tree untouched.
  fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
  const bad = parsePatch(patch(["*** Add File: should-not-exist.txt", "+nope", "*** Update File: x.txt", "-not-there", "+y"].join("\n")));
  assert.throws(() => applyPatchToDisk(bad, dir), PatchError);
  assert.equal(fs.existsSync(path.join(dir, "should-not-exist.txt")), false);

  // check() can veto.
  const vetoed = parsePatch(patch("*** Add File: v.txt\n+v"));
  assert.throws(() => applyPatchToDisk(vetoed, dir, () => { throw new PatchError("veto"); }), /veto/);
});
