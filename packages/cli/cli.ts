import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  Agent, MockProvider, OpenAIProvider, Session, APPROVAL_POLICIES, SANDBOX_MODES,
  applyOverrides, loadConfig, resolveApiKey, discoverInstructions, renderInstructions, systemPrompt,
  createTerminalUI, color, osSandboxAvailable, seatbeltProfile, wrapCommand, runShell,
  type ChatMessage, type ModexConfig, type Provider,
} from "@modex/core";

export const VERSION = "0.2.0";

const HELP = `Modex ${VERSION} — a Codex-style terminal coding agent

Usage: modex [OPTIONS] [PROMPT]
       modex [OPTIONS] <COMMAND> [ARGS]

Commands:
  exec [PROMPT]        Run Modex non-interactively (prompt from args or stdin)  [alias: e]
  review [--base REF]  Review the current git diff (uncommitted, or against REF) non-interactively
  resume [ID|--last]   Resume a saved session (default: most recent)
  sessions             List saved sessions
  sandbox <CMD...>     Run a command inside the Modex sandbox (for testing the policy)
  doctor               Diagnose config, provider, and sandbox availability
  help                 Show this help

Options:
  -m, --model <MODEL>                   Model to use (default from config)
  -a, --ask-for-approval <POLICY>       ${APPROVAL_POLICIES.join(" | ")}
  -s, --sandbox <MODE>                  ${SANDBOX_MODES.join(" | ")}
  -C, --cd <DIR>                        Working root for the agent
      --add-dir <DIR>                   Extra writable directory (repeatable)
      --full-auto                       Shorthand for -a never -s workspace-write
      --dangerously-bypass-approvals-and-sandbox
                                        No prompts, no sandbox. Only inside an external sandbox.
      --oss                             Use a local OpenAI-compatible server (Ollama) at http://localhost:11434/v1
  -c, --config <key=value>              Override a config value (JSON or raw string), e.g. -c model="gpt-5"
  -q, --quiet                           Print only the final answer on stdout (exec)
      --json                            Emit the final answer as JSON (exec)
  -V, --version                         Print version

Config: ~/.modex/config.json (override with MODEX_HOME). Keys: model, provider{name,base_url,api_key_env},
approval_policy, sandbox_mode, network_access, writable_roots, max_turns, shell_timeout_ms.
Env: OPENAI_API_KEY (or MODEX_API_KEY), MODEX_MODEL, MODEX_BASE_URL, MODEX_MOCK_SCRIPT.
Instructions: ~/.modex/AGENTS.md plus every AGENTS.md from the git root down to the cwd.
`;

interface ParsedArgs {
  command: string | null;
  positional: string[];
  model?: string;
  approval?: string;
  sandbox?: string;
  cd?: string;
  addDirs: string[];
  overrides: string[];
  fullAuto: boolean;
  bypass: boolean;
  oss: boolean;
  quiet: boolean;
  json: boolean;
  base?: string;
  help: boolean;
  version: boolean;
}

const COMMANDS = new Set(["exec", "e", "review", "resume", "sessions", "sandbox", "doctor", "help"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const p: ParsedArgs = { command: null, positional: [], addDirs: [], overrides: [], fullAuto: false, bypass: false, oss: false, quiet: false, json: false, help: false, version: false };
  const next = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (p.command === "sandbox") { p.positional.push(a); continue; }
    if (a === "--") { p.positional.push(...argv.slice(i + 1)); break; }
    switch (a) {
      case "-m": case "--model": p.model = next(i, a); i++; break;
      case "-a": case "--ask-for-approval": p.approval = next(i, a); i++; break;
      case "-s": case "--sandbox": p.sandbox = next(i, a); i++; break;
      case "-C": case "--cd": p.cd = next(i, a); i++; break;
      case "--add-dir": p.addDirs.push(next(i, a)); i++; break;
      case "-c": case "--config": p.overrides.push(next(i, a)); i++; break;
      case "--base": p.base = next(i, a); i++; break;
      case "--full-auto": p.fullAuto = true; break;
      case "--dangerously-bypass-approvals-and-sandbox": p.bypass = true; break;
      case "--oss": p.oss = true; break;
      case "-q": case "--quiet": p.quiet = true; break;
      case "--json": p.json = true; break;
      case "-h": case "--help": p.help = true; break;
      case "-V": case "--version": p.version = true; break;
      default:
        if (a.startsWith("-") && a !== "-" && !(p.command === "resume" && a === "--last")) throw new Error(`unknown option: ${a}`);
        if (!p.command && p.positional.length === 0 && COMMANDS.has(a)) p.command = a === "e" ? "exec" : a;
        else p.positional.push(a);
    }
  }
  return p;
}

export function buildConfig(p: ParsedArgs, env = process.env): ModexConfig {
  const cfg = loadConfig(env);
  const patch: Record<string, unknown> = {};
  if (p.model) patch.model = p.model;
  if (p.approval) patch.approval_policy = p.approval;
  if (p.sandbox) patch.sandbox_mode = p.sandbox;
  if (p.fullAuto) Object.assign(patch, { approval_policy: "never", sandbox_mode: "workspace-write" });
  if (p.bypass) Object.assign(patch, { approval_policy: "never", sandbox_mode: "danger-full-access" });
  if (p.oss) patch.provider = { name: "openai", base_url: env.MODEX_BASE_URL ?? "http://localhost:11434/v1", api_key_env: "OLLAMA_API_KEY" };
  if (p.addDirs.length) patch.writable_roots = [...cfg.writable_roots, ...p.addDirs];
  // Flags first, then explicit -c overrides win.
  const pairs = Object.entries(patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return applyOverrides(applyOverrides(cfg, pairs), p.overrides);
}

export function makeProvider(cfg: ModexConfig, env = process.env): Provider {
  if (cfg.provider.name === "mock") {
    if (!cfg.mock_script) throw new Error("mock provider requires mock_script (or MODEX_MOCK_SCRIPT)");
    return MockProvider.fromFile(cfg.mock_script);
  }
  const key = resolveApiKey(cfg, env);
  if (!key && /api\.openai\.com/.test(cfg.provider.base_url)) {
    throw new Error(`No API key found. Set ${cfg.provider.api_key_env} (or MODEX_API_KEY), or use --oss for a local model.`);
  }
  return new OpenAIProvider(cfg.provider.base_url, key);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function main(argv: string[]): Promise<number> {
  let p: ParsedArgs;
  try {
    p = parseArgs(argv);
  } catch (err) {
    console.error(color.red((err as Error).message));
    console.error(HELP);
    return 2;
  }
  if (p.version) { console.log(VERSION); return 0; }
  if (p.help || p.command === "help") { console.log(HELP); return 0; }

  const cfg = buildConfig(p);
  const cwd = path.resolve(p.cd ?? process.cwd());
  if (!fs.existsSync(cwd)) { console.error(color.red(`no such directory: ${cwd}`)); return 2; }

  switch (p.command) {
    case "doctor": return doctor(cfg, cwd);
    case "sessions": {
      const files = Session.list(cfg.home);
      if (!files.length) console.log("(no sessions)");
      for (const f of files) console.log(path.basename(f, ".jsonl"));
      return 0;
    }
    case "sandbox": {
      const command = p.positional.join(" ");
      if (!command) { console.error("usage: modex sandbox <command...>"); return 2; }
      const spec = { mode: cfg.sandbox_mode, writableRoots: [cwd, ...cfg.writable_roots.map((r) => path.resolve(cwd, r))], networkAccess: cfg.network_access };
      const wrapped = wrapCommand(command, spec);
      const result = await runShell(command, { cwd, timeoutMs: cfg.shell_timeout_ms, sandbox: spec });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (!wrapped.sandboxed) console.error(color.yellow("[modex] note: OS sandbox unavailable on this platform; command ran unsandboxed"));
      return result.exitCode ?? 1;
    }
    case "review": return review(cfg, cwd, p);
    case "resume": return interactive(cfg, cwd, p, p.positional[0] ?? "--last");
    case "exec": {
      const fromArgs = p.positional.join(" ").trim();
      const stdinText = process.stdin.isTTY ? "" : readStdin().trim();
      const prompt = fromArgs && fromArgs !== "-" ? (stdinText ? `${fromArgs}\n\n<stdin>\n${stdinText}\n</stdin>` : fromArgs) : stdinText;
      if (!prompt) { console.error("exec: a prompt is required (argument or stdin)"); return 2; }
      return exec(cfg, cwd, p, prompt);
    }
    default: {
      const prompt = p.positional.join(" ").trim();
      if (!process.stdin.isTTY && !prompt) {
        const stdinText = readStdin().trim();
        if (stdinText) return exec(cfg, cwd, p, stdinText);
      }
      return interactive(cfg, cwd, p, null, prompt || undefined);
    }
  }
}

function bootstrap(cfg: ModexConfig, cwd: string, ui: ReturnType<typeof createTerminalUI>, history?: ChatMessage[], session?: Session) {
  const provider = makeProvider(cfg);
  const instructions = renderInstructions(discoverInstructions(cwd, cfg.home));
  const sys = systemPrompt(cfg, cwd, instructions);
  const s = session ?? Session.create(cfg.home, cwd, cfg.model);
  const agent = new Agent({ cfg, provider, ui, cwd, session: s, systemPrompt: sys, history });
  return { agent, session: s };
}

async function exec(cfg: ModexConfig, cwd: string, p: ParsedArgs, prompt: string): Promise<number> {
  const ui = createTerminalUI({ quiet: p.quiet || p.json, nonInteractive: true });
  try {
    const { agent, session } = bootstrap(cfg, cwd, ui);
    ui.info(`modex ${VERSION} · model ${cfg.model} · ${cfg.approval_policy}/${cfg.sandbox_mode} · session ${session.meta.id}`);
    const result = await agent.run(prompt);
    if (p.json) console.log(JSON.stringify({ session: session.meta.id, turns: result.turns, tool_calls: result.toolCalls, final: result.finalMessage }));
    else if (p.quiet) console.log(result.finalMessage.trim());
    return 0;
  } catch (err) {
    ui.error((err as Error).message);
    return 1;
  } finally {
    ui.close();
  }
}

async function review(cfg: ModexConfig, cwd: string, p: ParsedArgs): Promise<number> {
  let diff: string;
  try {
    diff = execSync(p.base ? `git diff ${p.base}...HEAD` : "git diff HEAD", { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    console.error(color.red(`review: could not read git diff: ${(err as Error).message}`));
    return 1;
  }
  if (!diff.trim()) { console.log("Nothing to review: the diff is empty."); return 0; }
  const reviewCfg: ModexConfig = { ...cfg, sandbox_mode: "read-only", approval_policy: "never" };
  const prompt = [
    "Review the following diff as a careful senior engineer. Report bugs, risks, missing tests, and behavioral regressions, ordered by severity, with file:line references. Use the tools to read surrounding context when needed. Do not edit files. End with an overall verdict (approve / request changes) and a one-paragraph summary.",
    "",
    "```diff",
    diff.length > 200_000 ? diff.slice(0, 200_000) + "\n[diff truncated]" : diff,
    "```",
  ].join("\n");
  return exec(reviewCfg, cwd, { ...p, quiet: true }, prompt);
}

async function interactive(cfg: ModexConfig, cwd: string, p: ParsedArgs, resumeId: string | null, firstPrompt?: string): Promise<number> {
  const ui = createTerminalUI();
  let history: ChatMessage[] | undefined;
  let session: Session | undefined;
  if (resumeId) {
    const loaded = Session.load(cfg.home, resumeId);
    if (!loaded) { ui.error(`no saved session${resumeId === "--last" ? "s" : ` matching ${resumeId}`}`); return 1; }
    history = loaded.messages;
    session = loaded.session;
    ui.info(`resumed session ${session.meta.id} (${history.length} messages)`);
  }
  let agent: Agent;
  try {
    ({ agent, session } = bootstrap(cfg, cwd, ui, history, session));
  } catch (err) {
    ui.error((err as Error).message);
    return 1;
  }
  ui.info(`modex ${VERSION} · model ${cfg.model} · approval ${cfg.approval_policy} · sandbox ${cfg.sandbox_mode} · ${cwd}`);
  ui.info("type a task, /help for commands, /quit to exit");
  let pending = firstPrompt;
  for (;;) {
    const line = pending ?? (await ui.prompt(color.green("› ")));
    pending = undefined;
    if (line === null) break;
    const input = line.trim();
    if (!input) continue;
    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      if (cmd === "quit" || cmd === "exit" || cmd === "q") break;
      if (cmd === "help") { ui.info("/help  /quit  /model <name>  /approval <policy>  /sandbox <mode>  /diff  /clear  /session"); continue; }
      if (cmd === "model" && rest[0]) { cfg.model = rest[0]; ui.info(`model → ${cfg.model}`); continue; }
      if (cmd === "approval" && rest[0]) { try { cfg.approval_policy = applyOverrides(cfg, [`approval_policy="${rest[0]}"`]).approval_policy; ({ agent } = bootstrap(cfg, cwd, ui, agent.messages, session)); ui.info(`approval → ${cfg.approval_policy}`); } catch (e) { ui.error((e as Error).message); } continue; }
      if (cmd === "sandbox" && rest[0]) { try { cfg.sandbox_mode = applyOverrides(cfg, [`sandbox_mode="${rest[0]}"`]).sandbox_mode; ({ agent } = bootstrap(cfg, cwd, ui, agent.messages, session)); ui.info(`sandbox → ${cfg.sandbox_mode}`); } catch (e) { ui.error((e as Error).message); } continue; }
      if (cmd === "diff") { try { process.stdout.write(execSync("git diff HEAD", { cwd, encoding: "utf8" }) || "(no changes)\n"); } catch (e) { ui.error((e as Error).message); } continue; }
      if (cmd === "session") { ui.info(`${session!.meta.id} → ${session!.file}`); continue; }
      if (cmd === "clear") { ({ agent, session } = bootstrap(cfg, cwd, ui)); ui.info(`new session ${session.meta.id}`); continue; }
      ui.warn(`unknown command: /${cmd}`);
      continue;
    }
    try {
      await agent.run(input);
    } catch (err) {
      ui.error((err as Error).message);
    }
  }
  ui.close();
  return 0;
}

function doctor(cfg: ModexConfig, cwd: string): number {
  const key = resolveApiKey(cfg);
  const rows: [string, string][] = [
    ["version", VERSION],
    ["node", process.version],
    ["cwd", cwd],
    ["config", path.join(cfg.home, "config.json") + (fs.existsSync(path.join(cfg.home, "config.json")) ? "" : " (not found, using defaults)")],
    ["model", cfg.model],
    ["provider", `${cfg.provider.name} @ ${cfg.provider.base_url}`],
    ["api key", cfg.provider.name === "mock" ? "n/a (mock)" : key ? `present (${cfg.provider.api_key_env})` : `missing — set ${cfg.provider.api_key_env} or MODEX_API_KEY`],
    ["approval", cfg.approval_policy],
    ["sandbox", `${cfg.sandbox_mode} (os sandbox: ${osSandboxAvailable() ? "sandbox-exec available" : "unavailable on this platform"})`],
    ["network", cfg.network_access ? "enabled" : "disabled inside sandbox"],
    ["instructions", discoverInstructions(cwd, cfg.home).map((s) => s.path).join(", ") || "(none found)"],
    ["sessions", String(Session.list(cfg.home).length)],
  ];
  for (const [k, v] of rows) console.log(`${color.bold(k.padEnd(13))}${v}`);
  if (process.env.MODEX_SHOW_PROFILE) console.log("\n" + seatbeltProfile({ mode: cfg.sandbox_mode, writableRoots: [cwd], networkAccess: cfg.network_access }));
  return 0;
}
