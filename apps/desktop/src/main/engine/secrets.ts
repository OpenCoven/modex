import fs from "node:fs";
import path from "node:path";

/**
 * Secrets the user types into Modex (today: the TypeSafe API key for the Auto judge).
 *
 * Never in state.json, never in a build: values are encrypted with the OS keychain via
 * Electron's `safeStorage` (injected as a `Cipher` so tests and the e2e harness can
 * substitute one) and written to `<home>/app/secrets.json` with mode 0600. The renderer
 * only ever receives `describe()` — the source and last four characters.
 */
export interface Cipher {
  /** Human name of the backing store, e.g. "macOS Keychain". */
  readonly name: string;
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

export type SecretName = "typesafe_api_key";

interface SecretsFile {
  version: 1;
  /** base64 of the ciphertext, keyed by secret name. */
  entries: Partial<Record<SecretName, { enc: string; savedAt: string }>>;
}

export class SecretStore {
  readonly file: string;

  constructor(home: string, private readonly cipher: Cipher) {
    this.file = path.join(home, "app", "secrets.json");
  }

  get backend(): string {
    return this.cipher.name;
  }

  available(): boolean {
    return this.cipher.available();
  }

  private read(): SecretsFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<SecretsFile>;
      return { version: 1, entries: raw.entries ?? {} };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private write(data: SecretsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  has(name: SecretName): boolean {
    return Boolean(this.read().entries[name]);
  }

  get(name: SecretName): string | null {
    const entry = this.read().entries[name];
    if (!entry) return null;
    if (!this.cipher.available()) return null;
    try {
      const value = this.cipher.decrypt(Buffer.from(entry.enc, "base64"));
      return value.trim() || null;
    } catch {
      return null;
    }
  }

  set(name: SecretName, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return this.clear(name);
    if (!this.cipher.available()) throw new Error(`Cannot store the key: ${this.cipher.name} encryption is unavailable on this machine. Use TYPESAFE_API_KEY or \`jev config set apiKey …\` instead.`);
    const data = this.read();
    data.entries[name] = { enc: this.cipher.encrypt(trimmed).toString("base64"), savedAt: new Date().toISOString() };
    this.write(data);
  }

  clear(name: SecretName): void {
    const data = this.read();
    if (!data.entries[name]) return;
    delete data.entries[name];
    this.write(data);
  }

  /** What the UI may know: presence, where it lives, and the last four characters. */
  describe(name: SecretName): { present: boolean; backend: string; last4: string | null; savedAt: string | null; isReference: boolean } {
    const entry = this.read().entries[name];
    const value = entry ? this.get(name) : null;
    return { present: Boolean(entry), backend: this.cipher.name, last4: value ? value.slice(-4) : null, savedAt: entry?.savedAt ?? null, isReference: Boolean(value?.startsWith("op://")) };
  }
}

/** No encryption at all: refuses to store. The default until Electron wires safeStorage. */
export const noCipher: Cipher = {
  name: "no keychain",
  available: () => false,
  encrypt: () => { throw new Error("no cipher"); },
  decrypt: () => { throw new Error("no cipher"); },
};

/** Reversible, clearly-not-secret cipher for tests and the e2e harness (MODEX_E2E). */
export const testCipher: Cipher = {
  name: "test cipher (not secure)",
  available: () => true,
  encrypt: (plain) => Buffer.from(`e2e:${plain}`, "utf8"),
  decrypt: (blob) => {
    const s = blob.toString("utf8");
    if (!s.startsWith("e2e:")) throw new Error("not a test blob");
    return s.slice(4);
  },
};

/** Wraps Electron's safeStorage (only valid after `app.whenReady()`). */
export function electronCipher(safeStorage: { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }, platform = process.platform): Cipher {
  const name = platform === "darwin" ? "macOS Keychain" : platform === "win32" ? "Windows DPAPI" : "OS keyring";
  return { name, available: () => safeStorage.isEncryptionAvailable(), encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) };
}
