# Working in this repository

These rules apply to every session — a person in a terminal, Claude Code, Codex, or Modex
itself driving one of them.

## One worktree per session

- **Never edit in the primary checkout.** It stays on `main` and only ever receives
  `git pull`. Each session gets its own worktree under `.worktrees/<name>` on a branch of
  the same name, cut from `origin/main`:

  ```sh
  scripts/worktree.sh new <name>      # prints the worktree path; cd into it
  scripts/worktree.sh check           # exits 1 if you are still in the primary checkout
  scripts/worktree.sh remove <name>   # after the PR merged
  ```

  Pick a short slug for `<name>` that says what the session is doing (`thinking-item`,
  `fix-scroll`, `ci-macos`). `.worktrees/` is git-ignored.
- Two sessions must not share a worktree or a branch. If you find commits you did not make
  on your branch, stop and reconcile before pushing.
- Modex worktree threads (`⑂`) follow the same idea for the repositories Modex works on;
  they live under `~/.modex/worktrees/`, not here.

## Landing changes

- `main` is protected by a ruleset (`.github/rulesets/main.json`): **signed commits** and
  the **`unit + e2e (macOS)`** check are required; direct pushes are rejected.
- Flow: worktree → signed commits (`git commit -S`) → push the branch → PR → CI green → merge
  (squash). Then `scripts/worktree.sh remove <name>`.
- Before pushing, run what CI runs: `npm run build && npm test` and, for UI changes,
  `npm run test:e2e`.

## Where things are

- `apps/desktop` — the Electron app (`src/main` process + backends, `src/renderer` React UI,
  `e2e/` Playwright). `packages/core` — the offline scripted engine used by demos and tests.
- Real models run only through the `claude` and `codex` CLIs. There is no API mode; do not
  add one.
- Scratch scripts go in `apps/desktop/.probes/` (git-ignored). Playwright wipes
  `apps/desktop/test-results/` on every run.
