import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

/** A scriptable stand-in for a spawned CLI: tests feed stdout lines and inspect what was written to stdin. */
export class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  written: string[] = [];
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => { for (const line of d.toString().split("\n")) if (line.trim()) this.written.push(line); });
  }
  emitLine(o: unknown): void {
    this.stdout.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n");
  }
  kill(): boolean {
    this.killed = true;
    this.close(null);
    return true;
  }
  close(code: number | null): void {
    if (this.exitCode !== null || this.killed && code !== null) return;
    this.exitCode = code ?? 0;
    this.stdout.end();
    setImmediate(() => this.emit("close", code));
  }
  /** Waits until stdin has received a line matching `pred`. */
  async waitFor(pred: (line: string) => boolean, ms = 2000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const hit = this.written.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) throw new Error(`timed out waiting for stdin line; got: ${this.written.join(" | ")}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

export function fakeSpawn(proc: FakeProcess): { spawn: typeof import("node:child_process").spawn; calls: { file: string; args: string[]; cwd?: string }[] } {
  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const spawn = ((file: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ file, args, cwd: opts?.cwd });
    return proc as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls };
}

export function collectSink(answers: ("yes" | "no" | "always")[] = ["yes"]) {
  const events: string[] = [];
  const queue = [...answers];
  const sink = {
    delta: (t: string) => events.push(`delta:${t}`),
    assistant: (t: string) => events.push(`assistant:${t}`),
    toolStart: (t: { id: string; name: string; title: string }) => events.push(`tool_start:${t.id}:${t.title}`),
    toolUpdate: (id: string, p: { output?: string; ok?: boolean; status?: string }) => events.push(`tool_update:${id}:${p.status ?? ""}:${p.ok ?? ""}:${(p.output ?? "").slice(0, 40)}`),
    approval: async (req: { question: string }) => { events.push(`approval:${req.question}`); return queue.shift() ?? "no"; },
    notice: (level: string, text: string) => events.push(`notice:${level}:${text}`),
    thinkingDelta: (id: string, delta: string) => events.push(`think:${id}:${delta}`),
    thinkingDone: (id: string, text?: string) => events.push(`think_done:${id}:${text ?? ""}`),
    session: (h: string) => events.push(`session:${h}`),
  };
  return { sink, events };
}
