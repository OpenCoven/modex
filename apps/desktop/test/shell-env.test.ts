import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { extractPath, fallbackDirs, hydratePath, mergePaths, readLoginPath } from "../src/main/engine/shell-env.js";
import { tmpdir } from "./helpers.js";

/** A stand-in login shell: noisy profile output around the sentinel line, and a configurable PATH per flag. */
function fakeShell(opts: { ilc?: string | null; lc?: string | null; noise?: boolean; exitCode?: number; sleep?: number }): string {
  const dir = tmpdir("modex-shell-");
  const file = path.join(dir, "fakesh");
  const branch = (p: string | null | undefined) => (p == null ? "exit 7" : `PATH='${p}'; eval "$2"; exit ${opts.exitCode ?? 0}`);
  fs.writeFileSync(file, `#!/bin/sh
${opts.noise ? 'echo "Welcome back! nvm is loading..."; echo "PATH=/decoy/should/not/leak"' : ""}
${opts.sleep ? `sleep ${opts.sleep}` : ""}
case "$1" in
  -ilc) ${branch(opts.ilc)} ;;
  -lc) ${branch(opts.lc)} ;;
esac
`, { mode: 0o755 });
  return file;
}

test("extractPath reads only between the sentinels", () => {
  assert.equal(extractPath("banner\n__MODEX_PATH_START__/a:/b__MODEX_PATH_END__\nbye"), "/a:/b");
  assert.equal(extractPath("no markers"), null);
  assert.equal(extractPath("__MODEX_PATH_START____MODEX_PATH_END__"), null);
  assert.equal(extractPath("__MODEX_PATH_START__/a"), null);
});

test("mergePaths keeps priority order and drops duplicates and empties", () => {
  assert.equal(mergePaths("/nvm/bin:/usr/bin", "/usr/bin:/bin::", null, "/opt/homebrew/bin:/nvm/bin"), "/nvm/bin:/usr/bin:/bin:/opt/homebrew/bin");
  assert.equal(mergePaths(undefined, ""), "");
  assert.ok(fallbackDirs("/Users/x").split(":").includes("/Users/x/.local/bin"));
});

test("readLoginPath prefers the interactive login shell and ignores profile noise", async () => {
  const shell = fakeShell({ ilc: "/nvm/bin:/usr/bin", lc: "/only-lc/bin", noise: true });
  assert.deepEqual(await readLoginPath({ shell, env: { PATH: "/usr/bin:/bin" } }), { path: "/nvm/bin:/usr/bin", via: "-ilc" });
});

test("readLoginPath falls back to -lc, then to nothing, and honours MODEX_NO_LOGIN_PATH", async () => {
  assert.deepEqual(await readLoginPath({ shell: fakeShell({ ilc: null, lc: "/brew/bin" }), env: {} }), { path: "/brew/bin", via: "-lc" });
  assert.deepEqual(await readLoginPath({ shell: fakeShell({ ilc: null, lc: null }), env: {} }), { path: null, via: "none" });
  assert.deepEqual(await readLoginPath({ shell: "/definitely/not/a/shell", env: {} }), { path: null, via: "none" });
  assert.deepEqual(await readLoginPath({ shell: fakeShell({ ilc: "/x" }), env: { MODEX_NO_LOGIN_PATH: "1" } }), { path: null, via: "disabled" });
  const r = await readLoginPath({ shell: fakeShell({ ilc: "/fail/bin", exitCode: 1 }), env: {} });
  assert.deepEqual(r, { path: "/fail/bin", via: "-ilc" }, "a profile error after PATH is set still yields the PATH");
  const slow = await readLoginPath({ shell: fakeShell({ ilc: "/slow", lc: "/slow", sleep: 2 }), env: {}, timeoutMs: 200 });
  assert.equal(slow.path, null, "a hung profile times out instead of blocking startup");
});

test("hydratePath makes a CLI that only the login shell knows about spawnable from a Finder-style PATH", async () => {
  // A fake `claude` in a directory only the login shell's PATH contains.
  const bin = tmpdir("modex-nvm-bin-");
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho claude-from-login-path\n", { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: tmpdir("modex-home-") };
  const spawnClaude = () => new Promise<string>((resolve) => execFile("claude", [], { env }, (err, out) => resolve(err ? `ERR ${(err as NodeJS.ErrnoException).code}` : String(out).trim())));
  assert.equal(await spawnClaude(), "ERR ENOENT", "launchd's PATH cannot see it");
  const r = await hydratePath(env, { shell: fakeShell({ ilc: `${bin}:/usr/bin:/bin`, noise: true }) });
  assert.equal(r.via, "-ilc");
  assert.equal(env.PATH!.split(":")[0], bin, "login-shell entries come first");
  assert.ok(env.PATH!.includes("/usr/sbin"), "nothing the process already had is lost");
  assert.equal(await spawnClaude(), "claude-from-login-path");
});

test("hydratePath leaves PATH untouched when MODEX_NO_LOGIN_PATH opts out", async () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", MODEX_NO_LOGIN_PATH: "1" };
  const r = await hydratePath(env, { shell: fakeShell({ ilc: "/should/not/appear" }) });
  assert.deepEqual([r.via, env.PATH], ["disabled", "/usr/bin:/bin"]);
});
