import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { decide, isKnownSafeCommand, commandPrefix, type PolicyContext } from "../src/policy.js";

const ws = "/tmp/ws";
const ctx = (patch: Partial<PolicyContext> = {}): PolicyContext => ({
  approval: "on-request",
  sandbox: "workspace-write",
  workspace: ws,
  writableRoots: [],
  osSandboxAvailable: false,
  trustedPrefixes: [],
  ...patch,
});

test("isKnownSafeCommand: read-only commands and pipelines are safe; mutations and metachars are not", () => {
  for (const c of ["ls -la", "cat a.txt | grep foo | wc -l", "git status", "git log --oneline", "find . -name x", "sed -n 1,5p f", "rg TODO src"]) assert.equal(isKnownSafeCommand(c), true, c);
  for (const c of ["rm -rf /", "git push", "npm test", "echo hi > f", "ls; rm x", "find . -delete", "sed -i s/a/b/ f", "cat $(echo x)", ""]) assert.equal(isKnownSafeCommand(c), false, c);
});

test("decide: writes inside the workspace are allowed under workspace-write, outside ask/deny", () => {
  assert.equal(decide({ kind: "write", path: path.join(ws, "a.ts") }, ctx()), "allow");
  assert.equal(decide({ kind: "write", path: "/etc/hosts" }, ctx()), "ask");
  assert.equal(decide({ kind: "write", path: "/etc/hosts" }, ctx({ approval: "never" })), "deny");
  assert.equal(decide({ kind: "delete", path: path.join(ws, "a.ts") }, ctx({ sandbox: "read-only" })), "ask");
  assert.equal(decide({ kind: "write", path: "/other/root/f" }, ctx({ writableRoots: ["/other/root"] })), "allow");
});

test("decide: shell commands follow approval policy and sandbox availability", () => {
  const sh = (command: string) => ({ kind: "shell" as const, command, cwd: ws });
  assert.equal(decide(sh("git status"), ctx({ approval: "untrusted" })), "allow");
  assert.equal(decide(sh("npm test"), ctx({ approval: "untrusted" })), "ask");
  assert.equal(decide(sh("npm test"), ctx({ approval: "on-request", osSandboxAvailable: false })), "ask");
  assert.equal(decide(sh("npm test"), ctx({ approval: "on-request", osSandboxAvailable: true })), "allow");
  assert.equal(decide(sh("npm test"), ctx({ approval: "never" })), "allow");
  assert.equal(decide(sh("npm test"), ctx({ approval: "untrusted", trustedPrefixes: ["npm"] })), "allow");
  assert.equal(decide(sh("npm test"), ctx({ sandbox: "danger-full-access", approval: "untrusted" })), "ask");
  assert.equal(decide(sh("npm test"), ctx({ sandbox: "danger-full-access", approval: "on-request" })), "allow");
});

test("commandPrefix remembers `git <sub>` or the first word", () => {
  assert.equal(commandPrefix("git push origin main"), "git push");
  assert.equal(commandPrefix("npm run build"), "npm");
});
