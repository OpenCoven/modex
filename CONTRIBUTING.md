# Contributing to Modex

Read README.md and AGENTS.md first. Every development session uses its own worktree; do not edit the primary checkout. Use `scripts/worktree.sh new <name>`, make focused changes, and preserve the separation between coding-agent CLI execution and optional Jev routing.

Before submitting a PR, run the relevant documented checks: `npm run build`, `npm test`, and for UI changes `npm run test:e2e`. Commits are expected to be signed and main is protected. Never add model API credentials, weaken approval/sandbox behavior, or describe optional routing evidence as execution authorization.
