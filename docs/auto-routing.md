# Auto routing with Jev

Auto is the ⚡ toggle in the composer. When it is on, Modex asks a small, fast judge a few
typed questions about each request *before* the turn runs, then picks the backend, model,
reasoning effort, and fast mode for that turn — within limits you set — and shows a
one-line receipt in the transcript explaining why. The coding turn itself still runs only
through the `claude` and `codex` CLIs; nothing about Auto changes that.

## What the judge is

The judge is **Jev**, TypeSafe's System One model. It does not generate text and never sees
your files; it answers typed questions about a compact digest of the request and returns
calibrated probabilities. Modex asks six questions in one request
(`apps/desktop/src/main/engine/routing/judge.ts`, question set v1):

| id | type | what it decides |
| --- | --- | --- |
| `task` | choice | quick answer · small edit · bug fix · feature · refactor · investigation · review · ops · unclear |
| `complexity` | score 0–3 | one-step … cross-cutting, each level a concrete situation |
| `blast_radius` | score 0–2 | one file … could delete data / rewrite history / touch other systems |
| `wants_speed` | noul | the user signalled a quick turnaround matters more than thoroughness |
| `needs_deep_reasoning` | noul | doing it well needs multi-step reasoning about interactions |
| `depends_on_prior_turns` | noul | only when the thread has history: the request leans on it |

The state sent is the request (clipped to 4k chars), the last six turns as short digests
(user/assistant text clipped, tool titles), and thread/project facts (backend, mode, plan,
turn count, project name, branch). No file contents, diffs, or tool output are sent.

Jev is contacted over HTTPS (`POST https://api.typesafe.ai/v1/systemone`) with the key in
`TYPESAFE_API_KEY`. Modex reads that variable from its own environment or, because a
Finder-launched app inherits no shell profile, from your login shell once at first use. The
key is never written to disk by Modex. With no key, Auto still works using a deterministic
built-in heuristic, and every receipt says so ("heuristic" instead of "Jev 0.82").

Pricing and limits, from the TypeSafe model page at the time of writing: `jev-latest` →
`jev-1.13.0`, charged per input token at $0.042 per million (output free), 32k tokens of
state per request. A routing call sends a few hundred tokens, so Auto costs well under a
hundredth of a cent per turn and typically answers in well under a second; a turn waits at
most 8 s for the judge before falling back to the heuristic.

## What code decides

Jev's answers are raw judgments. The policy (`routing/policy.ts`) turns them into a route,
deterministically, and every step that changes the outcome adds a reason to the receipt:

1. **Confidence gate.** If Jev's confidence in the task kind is below `min_confidence`
   (default 0.6), Auto keeps whatever the thread was already using and says so.
2. **Target tier.** Starts at the complexity score; +1 for deep reasoning; +1 for a wide or
   hard-to-reverse blast radius; a quick answer with low complexity pins tier 0; posture
   shifts one tier down (economy) or up (quality); the learned per-task offset is added;
   clamped to 0–3; capped at 2 once the daily premium budget is spent.
3. **Backend.** Stays put unless `allow_backend_switch` is on **and** switching would not
   throw away a CLI session (no session yet, or the request does not depend on prior
   turns). Even then it only moves when the current CLI cannot reach the target tier or is
   unavailable. Mid-thread switches lose the CLI's context, so this is off by default.
4. **Model.** The highest rung at or below the target tier on that backend
   (`routing/catalog.ts`). The ladder is rebuilt from the CLI's live model list: Claude's
   aliases (haiku 0 · sonnet 1 · opus 2 · fable 3) and Codex's catalogue (gpt-5.5 0 ·
   gpt-5.6-* 1 · gpt-6-luna/sol 2 · gpt-6-astra 3), with description hints for anything new
   and the middle tier for unknowns.
5. **Effort.** Tier sets the base (low/medium/high/xhigh); deep reasoning bumps one; an
   explicit speed signal drops one; `max_effort` caps it; the budget caps it at high. The
   result snaps to an effort the model actually lists. Claude gets `--effort`, Codex gets
   the per-turn `effort` field.
6. **Fast mode.** Only when the user signalled speed, the task is not reasoning-heavy, the
   pick is tier ≤ 1, and the model offers it. Codex: the `fast` service tier for this turn
   only (`serviceTierForTurn`). Claude: `--settings '{"fastMode":true}'` for the session.

Changing the policy never requires re-asking Jev; the raw judgments are reusable.

## How it learns you

`~/.modex/app/routing-fit.json` (`routing/fit.ts`) keeps a per-task-kind tier offset:

- You pick a different model by hand on an Auto thread → strongest signal. Choosing a higher
  tier than Auto did nudges that task kind up by 0.34 tiers (three consistent overrides move
  it a full tier); a lower one nudges down. Modex confirms what it learned in a notice.
- An Auto turn fails → a small nudge up (0.1).
- Offsets are clamped to ±1.5 and rounded to the nearest half tier when applied, so one
  override never flips a decision on its own.

The file also counts premium turns per day (`premium_turns_per_day` bound) and keeps the
last 200 routing records with outcomes, which is the dataset a future calibrated fit model
(or a threshold sweep in `.probes/`) would train on. Settings → "Reset learning" clears it.

## Bounds you control

Settings → Auto routing: posture, effort ceiling, minimum judge confidence, premium turns per
day, fast-mode allowance, backend switching, and whether new threads start on Auto. All of
these are `settings.routing` in `~/.modex/app/state.json`.

## Which CLIs, and local models

Modex drives coding agents only through their CLIs, so a routing target is any CLI that
Modex has a backend for. Surveyed on 2026-09-25:

| CLI | headless protocol | approvals | model / effort control | verdict |
| --- | --- | --- | --- | --- |
| **Codex** (`codex app-server`) | JSON-RPC over stdio, streaming items | server→client requests | `model`, `effort`, `serviceTierForTurn` per turn; live `model/list` with efforts and service tiers | shipped; the richest surface |
| **Claude Code** (`claude -p`) | stream-json in/out | `control_request` on stdio | `--model`, `--effort low…max`, fast mode via settings | shipped |
| Gemini CLI | `-p --output-format stream-json` | `--approval-mode default/auto_edit/yolo/plan` (no per-call prompt channel found) | `-m` | good next candidate once its permission prompts can be answered from a host |
| GitHub Copilot CLI | `-p` | `--allow-all-tools` only | `--model` (incl. `auto`) | possible for chat/plan modes; no interactive approval path yet |
| opencode (installed build) | `-p -f json` | none | none in headless | not a fit for agent mode |
| **Local models** | via **Codex** `--oss --local-provider lmstudio|ollama` (LM Studio has `qwen/qwen3.5-9b` on this machine) | Codex's | Codex's | the right way in: a tier-0 rung on the Codex ladder, no API mode in Modex |

Recommendation: keep Claude and Codex as the routing targets now; add local models as a
Codex profile (`codex --oss`) rather than a new backend, so `AGENTS.md`'s CLI-only rule
holds; evaluate Gemini CLI as the third backend when its headless approvals can be driven.

## Verifying

- Unit: `npm test -w @modex/desktop` covers the heuristic judge, the policy table, the fit
  arithmetic, the router with a fake Jev transport and with Jev failing, and the runner
  applying a route before a turn.
- End to end: `npm run test:e2e` toggles Auto on the mock backend and checks the receipt.
- Live: export `TYPESAFE_API_KEY`, start Modex, turn on Auto, send a request; the receipt
  reads "Jev 0.xx" and Settings shows "Jev is live".
