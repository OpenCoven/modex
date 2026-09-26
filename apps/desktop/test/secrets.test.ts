import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SecretStore, noCipher, testCipher, electronCipher } from "../src/main/engine/secrets.js";
import { tmpdir } from "./helpers.js";

test("secret store: encrypts at rest with 0600, describes without revealing, clears, and refuses without a cipher", () => {
  const home = tmpdir("modex-home-");
  const store = new SecretStore(home, testCipher);
  assert.equal(store.has("typesafe_api_key"), false);
  assert.deepEqual(store.describe("typesafe_api_key"), { present: false, backend: "test cipher (not secure)", last4: null, savedAt: null, isReference: false });
  store.set("typesafe_api_key", "  sk-live-abcdef1234  ");
  assert.equal(store.get("typesafe_api_key"), "sk-live-abcdef1234");
  const file = path.join(home, "app", "secrets.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.includes("sk-live-abcdef1234"), false, "plaintext never touches disk");
  assert.equal(fs.existsSync(path.join(home, "app", "state.json")), false, "nothing lands in state.json");
  const d = store.describe("typesafe_api_key");
  assert.deepEqual([d.present, d.last4, d.isReference, typeof d.savedAt], [true, "1234", false, "string"]);
  store.set("typesafe_api_key", "op://Development/Jev API Key/password");
  assert.equal(store.describe("typesafe_api_key").isReference, true);
  assert.equal(new SecretStore(home, testCipher).get("typesafe_api_key"), "op://Development/Jev API Key/password", "survives a restart");
  store.set("typesafe_api_key", "   ");
  assert.equal(store.has("typesafe_api_key"), false, "an empty value clears");
  store.set("typesafe_api_key", "k");
  store.clear("typesafe_api_key");
  assert.equal(store.get("typesafe_api_key"), null);
  const locked = new SecretStore(tmpdir("modex-home-"), noCipher);
  assert.throws(() => locked.set("typesafe_api_key", "k"), /no keychain encryption is unavailable/);
  assert.equal(locked.available(), false);
  // A blob written by another cipher cannot be read; that is a null key, not a crash.
  const other = new SecretStore(home, { name: "other", available: () => true, encrypt: (s) => Buffer.from(s), decrypt: () => { throw new Error("nope"); } });
  other.set("typesafe_api_key", "x");
  assert.equal(new SecretStore(home, testCipher).get("typesafe_api_key"), null);
});

test("electronCipher wraps safeStorage and names the platform store", () => {
  const calls: string[] = [];
  const fake = { isEncryptionAvailable: () => true, encryptString: (s: string) => { calls.push(`enc:${s}`); return Buffer.from(s.split("").reverse().join("")); }, decryptString: (b: Buffer) => { calls.push("dec"); return b.toString().split("").reverse().join(""); } };
  const mac = electronCipher(fake, "darwin");
  assert.equal(mac.name, "macOS Keychain");
  assert.equal(electronCipher(fake, "win32").name, "Windows DPAPI");
  assert.equal(electronCipher(fake, "linux").name, "OS keyring");
  assert.equal(mac.decrypt(mac.encrypt("abc")), "abc");
  assert.deepEqual(calls, ["enc:abc", "dec"]);
});
