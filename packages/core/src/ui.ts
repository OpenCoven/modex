import readline from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import type { ApprovalAnswer } from "./types.js";

const isTTY = stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { dim: c("2"), bold: c("1"), cyan: c("36"), green: c("32"), yellow: c("33"), red: c("31"), magenta: c("35") };

export interface UI {
  info(msg: string): void;
  assistant(msg: string): void;
  tool(title: string, body?: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Returns "yes", "no", or "always". */
  confirm(question: string, detail?: string): Promise<ApprovalAnswer>;
  prompt(label: string): Promise<string | null>;
  close(): void;
}

export function createTerminalUI(opts: { quiet?: boolean; nonInteractive?: boolean } = {}): UI {
  let rl: readline.Interface | null = null;
  const getRl = () => (rl ??= readline.createInterface({ input: stdin, output: stdout, terminal: stdout.isTTY }));
  const log = (s: string) => (opts.quiet ? stderr.write(s + "\n") : stdout.write(s + "\n"));
  return {
    info: (m) => log(color.dim(m)),
    // In quiet mode the caller prints the final answer itself; intermediate replies are dropped.
    assistant: (m) => { if (!opts.quiet) stdout.write(color.magenta("modex") + " " + m.trimEnd() + "\n"); },
    tool: (title, body) => {
      log(color.cyan(`▸ ${title}`));
      if (body) log(color.dim(indent(body)));
    },
    warn: (m) => stderr.write(color.yellow(m) + "\n"),
    error: (m) => stderr.write(color.red(m) + "\n"),
    async confirm(question, detail) {
      if (opts.nonInteractive || !stdin.isTTY) return "no";
      stdout.write(color.yellow(`? ${question}`) + "\n");
      if (detail) stdout.write(color.dim(indent(detail)) + "\n");
      const answer = (await getRl().question(color.bold("  [y]es / [n]o / [a]lways: "))).trim().toLowerCase();
      if (answer === "a" || answer === "always") return "always";
      return answer === "y" || answer === "yes" ? "yes" : "no";
    },
    async prompt(label) {
      try {
        const line = await getRl().question(color.bold(label));
        return line;
      } catch {
        return null; // closed (Ctrl-D)
      }
    },
    close: () => rl?.close(),
  };
}

function indent(s: string): string {
  const lines = s.split("\n");
  const shown = lines.slice(0, 40);
  const rest = lines.length - shown.length;
  return shown.map((l) => `  ${l}`).join("\n") + (rest > 0 ? `\n  … ${rest} more lines` : "");
}
