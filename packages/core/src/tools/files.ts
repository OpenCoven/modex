import fs from "node:fs";
import path from "node:path";
import { truncate } from "./shell.js";

const IGNORED = new Set(["node_modules", ".git", "dist", ".next", "target", ".DS_Store"]);

export function readFileTool(cwd: string, args: { path: string; offset?: number; limit?: number }): string {
  const abs = path.resolve(cwd, args.path);
  if (!fs.existsSync(abs)) return `error: ${args.path} does not exist`;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return `error: ${args.path} is a directory (use list_dir)`;
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const offset = Math.max(1, args.offset ?? 1);
  const limit = Math.max(1, Math.min(args.limit ?? 400, 2000));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const width = String(offset + slice.length).length;
  const body = slice.map((l, i) => `${String(offset + i).padStart(width)}| ${l}`).join("\n");
  const more = offset - 1 + limit < lines.length ? `\n[${lines.length - (offset - 1 + limit)} more lines]` : "";
  return truncate(body) + more;
}

export function listDirTool(cwd: string, args: { path?: string; depth?: number }): string {
  const rel = args.path ?? ".";
  const abs = path.resolve(cwd, rel);
  if (!fs.existsSync(abs)) return `error: ${rel} does not exist`;
  const depth = Math.max(1, Math.min(args.depth ?? 2, 5));
  const out: string[] = [];
  walk(abs, "", 0);
  function walk(dir: string, prefix: string, level: number) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      out.push(`${prefix}[unreadable: ${(err as Error).message}]`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      out.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory() && level + 1 < depth) walk(path.join(dir, e.name), prefix + "  ", level + 1);
      if (out.length > 500) {
        out.push("[listing truncated]");
        return;
      }
    }
  }
  return out.join("\n") || "(empty)";
}

export function writeFileTool(cwd: string, args: { path: string; content: string }): string {
  const abs = path.resolve(cwd, args.path);
  const existed = fs.existsSync(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, args.content);
  return `${existed ? "updated" : "created"} ${args.path} (${Buffer.byteLength(args.content)} bytes)`;
}
