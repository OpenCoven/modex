import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatMessage } from "./types.js";

export interface SessionMeta {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
}

/** Append-only JSONL transcript under ~/.modex/sessions/, one file per session. */
export class Session {
  readonly file: string;
  constructor(readonly meta: SessionMeta, home: string) {
    const dir = path.join(home, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${meta.createdAt.replace(/[:.]/g, "-")}-${meta.id}.jsonl`);
    if (!fs.existsSync(this.file)) fs.appendFileSync(this.file, JSON.stringify({ type: "meta", ...meta }) + "\n");
  }

  static create(home: string, cwd: string, model: string): Session {
    return new Session({ id: crypto.randomUUID().slice(0, 8), createdAt: new Date().toISOString(), cwd, model }, home);
  }

  static list(home: string): string[] {
    const dir = path.join(home, "sessions");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(dir, f));
  }

  /** Loads a session by id (or the most recent when `id` is "--last"/undefined). */
  static load(home: string, id?: string): { session: Session; messages: ChatMessage[] } | null {
    const files = Session.list(home);
    const file = !id || id === "--last" ? files[files.length - 1] : files.find((f) => f.includes(`-${id}.jsonl`));
    if (!file) return null;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    let meta: SessionMeta | null = null;
    const messages: ChatMessage[] = [];
    for (const line of lines) {
      const rec = JSON.parse(line) as { type: string } & Record<string, unknown>;
      if (rec.type === "meta") {
        const { type: _t, ...rest } = rec;
        meta = rest as unknown as SessionMeta;
      } else if (rec.type === "message") messages.push(rec.message as ChatMessage);
    }
    if (!meta) return null;
    return { session: new Session(meta, home), messages };
  }

  append(message: ChatMessage): void {
    fs.appendFileSync(this.file, JSON.stringify({ type: "message", at: new Date().toISOString(), message }) + "\n");
  }
}
