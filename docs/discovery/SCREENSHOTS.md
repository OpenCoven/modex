# Modex screenshot protocol

The existing [approval-card image](../screenshots/01-thread-approval.png) is a checked-in screenshot, not new evidence from this documentation change. Keep its original provenance; do not relabel it as a capture of the latest build.

For fresh captures, use the README's offline screenshot path from an isolated worktree:

```sh
npm run build
npm run screenshot -w @modex/desktop -- --screenshot=/tmp/modex-shots --demo-answer=yes
```

This is an explicit reproduction command, not a claim it was run here. It seeds a throwaway demonstration rather than requiring a CLI login. Never change an ordinary project to full-access mode or launch live coding turns for marketing imagery.

Capture an overview, an approval before it is accepted, and the Changes panel after the synthetic demonstration. Include the source commit, command, operating system, viewport, theme, fixture, and offline mode in the capture record. Review repository paths, user names, notifications, and terminal output for private information before publishing.

Follow the [shared evidence protocol](https://github.com/TypeSafeAI/.github/blob/main/docs/discovery/SCREENSHOTS.md). The editorial card in this directory is not a screenshot; it must not be used to imply that any command executed or approval was granted.
