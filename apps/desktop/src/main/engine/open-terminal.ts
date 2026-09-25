import { spawn } from "node:child_process";

/** The command that opens the platform's terminal at `dir`. Exported for tests. */
export function terminalCommand(platform: NodeJS.Platform, dir: string): { file: string; args: string[] } {
  switch (platform) {
    case "darwin":
      // Terminal.app (or whatever the user set as default for the bundle id) opens a window at the folder.
      return { file: "open", args: ["-a", process.env.MODEX_TERMINAL_APP ?? "Terminal", dir] };
    case "win32":
      return { file: "cmd.exe", args: ["/c", "start", "", "cmd.exe", "/K", `cd /d "${dir}"`] };
    default:
      return { file: process.env.MODEX_TERMINAL ?? "x-terminal-emulator", args: [`--working-directory=${dir}`] };
  }
}

export function openTerminal(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const { file, args } = terminalCommand(platform, dir);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    child.once("error", (err) => reject(new Error(`could not open a terminal (${file}): ${err.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
