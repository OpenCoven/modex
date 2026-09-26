# Contributing to Modex

Read [README.md](README.md), [AGENTS.md](AGENTS.md), and the [developer entry point](docs/discovery/README.md) first. This is an independent community application, not an official TypeSafe AI, OpenAI, or Anthropic product.

## Work in isolation

Every development session uses its own worktree. Run `scripts/worktree.sh new <name>` and work there; do not edit the primary checkout or reuse another session's branch. Preserve the existing signing and main-branch requirements. Keep each PR focused, and do not combine dependency changes with unrelated documentation work.

## Preserve execution boundaries

Coding turns use the existing CLI backends. Optional Jev routing supplies selection evidence; it does not authorize execution. Do not weaken approval or sandbox behavior. Never commit real API credentials, place keys in fixtures or logs, or expand provider access as incidental cleanup. Read `docs/auto-routing.md` before changing the optional judge.

## Verify and submit

```sh
npm run build
npm test
npm run test:e2e
```

Use the platform and offline fixtures expected by the repository's CI. Explain what changed, which checks ran, their actual results, and anything unverified. Do not describe a synthetic run as live-provider evidence. Main remains subject to its signing and CI gates.

For visual changes, follow the [screenshot protocol](docs/discovery/SCREENSHOTS.md). Use the offline demo, record the source commit and environment, and review captures for private paths and text. Preserve the MIT license and existing third-party credits.
