import type { ToolSpec } from "../types.js";

/** Tool schemas advertised to the model. Execution lives in agent.ts so policy can gate it. */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "shell",
    description:
      "Run a shell command in the workspace and return its stdout/stderr/exit code. Commands run under the configured sandbox; prefer read-only commands (ls, cat, grep, git status/diff, tests) and keep output small.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute with `$SHELL -lc`." },
        timeout_ms: { type: "integer", description: "Optional timeout in milliseconds." },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read a text file with line numbers. Use offset/limit to page through large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace." },
        offset: { type: "integer", description: "1-based first line to return (default 1)." },
        limit: { type: "integer", description: "Maximum number of lines to return (default 400)." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List files and directories (skips node_modules, .git, dist).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace (default '.')." },
        depth: { type: "integer", description: "Recursion depth, 1-5 (default 2)." },
      },
    },
  },
  {
    name: "apply_patch",
    description:
      "Create, update, delete, or move files using the apply_patch format. Wrap the patch in '*** Begin Patch' / '*** End Patch'; use '*** Add File: path', '*** Delete File: path', or '*** Update File: path' with unified-diff style hunks (' ' context, '-' remove, '+' add, optional '@@ context header'). Include at least 3 lines of context per hunk.",
    parameters: {
      type: "object",
      properties: { patch: { type: "string", description: "The full patch text." } },
      required: ["patch"],
    },
  },
  {
    name: "write_file",
    description: "Overwrite (or create) a file with the given content. Prefer apply_patch for edits to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace." },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
];
