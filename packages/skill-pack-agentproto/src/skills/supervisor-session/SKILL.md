---
name: supervisor-session
description:
  Run a SUPERVISOR session with agentproto — the orchestrator (Claude,
  expensive tokens) does not code but keeps its hands on the wheel. Proven
  pipeline (agentproto VS Code extension, 2026-07-14) - source-verified scout
  recon → SPEC + frozen interfaces → disjoint WP briefs → parallel executors
  (cheap models) → systematic disk verification → single-writer consolidation →
  adversarial verify + live e2e → PR ("done" read from the repo's AGENTS.md,
  never restated here). Trigger when the user wants to "supervise as much as
  possible while keeping the ability to act", have a multi-WP deliverable
  built by cheap models, or industrialize scout→brief→execution→verify→commit.
  Complements light-coder-orchestration (model choice + Sonnet safety net) and
  durable-supervision (in-daemon policies) - this is the supervisor's
  OPERATING LOOP.
---

# Supervisor session (agentproto)

**Principle**: the supervisor holds the _plan, the contracts, and the disk
truth_; the sessions hold the _work_. You do not code — EXCEPT for
consolidation and surgical fixes (1 file, known cause), because the worktree is
local: that is what "keeping the ability to act" means.

## Pipeline (roles → artifacts)

```
scout (1M-ctx model, cheap)       → recon doc VERIFIED against source (spot-check grep it yourself)
you                               → SPEC.md + FROZEN interface contract + per-WP file matrix
parallel executors (cheap)        → WPs on DISJOINT scopes (briefs = .plans/ files)
you (after each turn-end)         → disk verification + targeted checkpoint commit
you (single writer)               → consolidation (shared files: extension.ts, package.json…)
verify session (Sonnet, sub)      → re-run gates + adversarial review of the diff (does not fix, reports)
you                               → LIVE e2e (tsx script against the real daemon) + PR (cf. the repo's AGENTS.md)
```

- **WP0 foundation first, alone**: it FREEZES the interfaces (client, store,
  command ids). WP1..N code against those names without coordinating.
- **Shared files belong to nobody.** Each brief forbids `package.json` /
  `extension.ts` (and equivalents) and requires in the final report: _the exact
  wiring lines + config snippets to merge_. Consolidation (you) applies them in
  one pass and resolves collisions (e.g. two WPs claiming the same command →
  rename one).
- Briefs = files in `.plans/<project>/WPn-brief.md`; the session prompt
  contains ONLY the pointer + the overrides (no-git, no-subagents, parallel-
  aware). Mandatory final report: files touched, design choices, wiring
  lines, REAL exit codes.

## Preflight (before any spawn)

1. Load the TARGET repo's agent-instructions file (not this one) — "done" is
   declared there, never here (same discipline as in End of session: this
   skill points, it does not restate).
2. `auth_profile_list` + `adapter_list` BEFORE any spawn: choose the
   executor's auth from the profile's METHOD — a gateway provider (openrouter,
   moonshot) wants an api-key profile (`access.profileRef`), never
   `auth:{mode:"subscription"}` (reserved for Anthropic/claude-code). Billing
   fallback when a provider is dead/flaky: OpenRouter cheap → claude-sdk
   moonshot (kimi) → claude-code `subscription` + cheap Anthropic (haiku),
   zero marginal cost. Never block the pipeline on a dead provider.

## Brief Contract (paste verbatim into every brief)

Paste this block as-is at the top of every executor/supervisor brief — it is
what carries the discipline through to models that load no skill at all
(hermes, OpenRouter, bare models). Do not paraphrase it, do not translate it:
mechanical re-copying of skill/doc content has already corrupted facts in the
past — this block must travel identical to its source.

```
- Definition of done: POINTER, never restated. Load the target repo's agent-instructions file (agentproto/ts → root AGENTS.md) and obey it verbatim: green local gate + open PR = terminal state; never `gh pr merge`; changeset written by the reviewer, not by hand; no AI attribution in commits/PR.
- Gate = exit code, never piped output: `pnpm test > /tmp/gate.log 2>&1; echo "EXIT=$?"` then grep the log. `| tail` reports tail's exit, not the gate's.
- Truth = disk, never the report. Read the actual diff; re-run the gate yourself.
- Waits are FOREGROUND/blocking, never yield-the-turn: `agentproto sessions wait <id> --until turn-end --timeout <ms>` backgrounded, or `session_monitor` (≤49s) for a quick check. A stopped agent-cli session has no timer — yielding to "wait" is a dead end.
- A wedged session (bus says awaiting-input but enqueue says mid-turn, or empty turns) → `agent_prompt interrupt:true` redirects without losing context; `agent_kill` only if truly dead (code is on disk).
- Executor auth is read from the profile's METHOD, before spawning: `auth_profile_list` + `adapter_list`. Gateway providers (openrouter/moonshot) need an api-key profile via `access.profileRef` — NOT `auth:{mode:"subscription"}`. Billing fallback when a provider is flaky/dead: OpenRouter-cheap → claude-sdk moonshot (kimi) → claude-code `subscription` + cheap Anthropic (haiku), marginal-cost-zero. Never block the pipeline on a dead provider.
```

The first bullet ("Definition of done") points to the target repo's AGENTS.md
— it does not replace it; adapt `agentproto/ts → root AGENTS.md` if the target
repo differs.

## Native worktree — provision + spawn in ONE move

**The DEFAULT: NEVER do `git worktree add` + `pnpm install` by hand.**
Pass the `worktree` field to `agent_start` and the daemon takes care of it:

- `agent_start({ cwd: <target repo>, worktree: { slug, base: "origin/main" } })`
  (or `worktree: true`, slug auto-minted from `label`). The daemon runs
  `git worktree add -b wt/<slug> … origin/main` **then plays the setup hooks
  from the repo's `agentproto.json`** (for `agentproto/ts`: `pnpm install
  --prefer-offline` + `pnpm build`) BEFORE spawning the adapter inside it. So
  install + build are AUTOMATIC — zero manual git/pnpm gestures.
- The worktree lands OUTSIDE the monorepo (daemon's `worktrees.root`, default
  `~/.agentproto/worktrees/<repo>/<slug>`) — which also settles the
  "worktree as a sibling of `ts/` → pnpm/turbo package collision" trap
  (worktree OUTSIDE the monorepo by construction).
- **Root only.** Honored only for a ROOT spawn; a child spawned THROUGH this
  orchestrator inherits the parent's tree (no second worktree) — so do NOT
  provision per-child. Ignored for a `sandbox` spawn (the box already
  isolates). Requires an explicit `cwd` (or `workspaceSlug`), otherwise
  `worktree_requires_explicit_repo` (no branch cut at random off the active
  workspace). A daemon policy `worktrees.isolation` (`always` / `never`,
  env `AGENTPROTO_WORKTREES_ISOLATION` > config) can force/forbid it
  globally; default `on-request`.
- **Teardown = by hand AFTER merge** (the worktree is NOT deleted on session
  close): `agentproto worktree rm|archive <path|slug>` (`rm` refuses if the
  tree is dirty unless `--discard-modified/--discard-untracked`; `archive`
  snapshots first under `~/.agentproto/worktree-salvage/`), or
  `agentproto worktree gc --apply` to sweep the merged+clean+idle ones.
- **Fallback — a local worktree of YOUR OWN** (when the supervisor wants its
  OWN worktree to consolidate/edit WITHOUT spawning an agent):
  `agentproto worktree new <slug> [--base origin/main]` (creates under
  `worktrees.root`, branch `wt/<slug>`, plays the setup hooks — `--no-setup`
  to skip them) — NOT a raw hand-made `git worktree add`.

## Spawn protocol (hermes / OpenRouter models)

1. `agent_start` **idle** (no initial prompt!), `role: "executor"` (strips
   agent_start/agent_prompt), `cwd` = the target repo + `worktree: { slug, base:
   "origin/main" }` (cf. previous section — the daemon provisions + installs;
   no hand-made worktree).
2. `/model <slug>` alone → wait for turn-end → **verify the
   `Model switched to: <slug> · Provider: …` line** in agent_output.
3. Liveness ping: `Reply with exactly: READY` → non-empty turn = healthy
   session.
4. Only then, the brief.

**Why**: `/model` in the spawn prompt makes hermes FREELANCE (it explores the
repo on the expensive default model — lived: ~$1.9 for one turn, for nothing).
And an empty turn after the switch ≠ doomed session: see Diagnostics.

For claude-code/claude-sdk: `model` + `auth {mode:"subscription"}` (or
`mode:"moonshot"` + kimi) **and `worktree`** are pinned AT SPAWN — no /model
dance, the brief can go out in the initial prompt.

## Monitoring (frugal with supervisor tokens)

- Quick check: `session_monitor` (≤49s), fan-in via `sessionIds: [...]`.
- Long wait:
  `npx agentproto sessions wait <id> --until turn-end --timeout 2400000`
  **backgrounded** (lived trap: timeout is in **ms** — `900` = 900 ms). Fan-in:
  a `for s in …; do wait; done` loop in ONE SINGLE background task.
- NEVER read the whole output: `agent_output clean lastN 40-60` after
  turn-end, that's all.

## Truth = disk, never the report

After each "green" WP: `git status --porcelain` (exact scope — nothing outside
the perimeter), re-run the gate YOURSELF (real exit codes), **targeted**
checkpoint commit (`git add <paths>`, `--no-verify` if a hook sweeps up the
WIP, NO push). The executor's report serves consolidation, not trust.

## Diagnosing empty turns / "wedged" sessions

**Before** any theory about session state: `tail ~/.hermes/logs/errors.log`
(or the session's events.jsonl). Lived: 3 different models "wedged"
simultaneously = **OpenRouter 402 Insufficient credits**; and
`moonshotai/kimi-k2.7` = 400 invalid model id (valid slug:
`moonshotai/kimi-k2`). Identical symptom in both cases:
`[warning] empty turn — cost $null`.

- A queued prompt does NOT interrupt a turn; `interrupt: true` redirects the
  session without losing its context; `agent_kill` if truly dead (the written
  code is on disk, nothing is lost).
- Billing fallback when a provider goes down: OpenRouter cheap → claude-sdk
  moonshot (kimi-k2.7-code) → claude-code `subscription` (zero marginal cost,
  Sonnet-5). Never block the pipeline on a dead provider.

## STOP-on-fork: make it real

Every brief: "design fork not covered → STOP and ask" + the likely forks named
with their default. It works (lived: the WP0 executor detected that the recon
doc invented events on `GET /events` and proposed 3 options instead of coding
against a phantom endpoint). When a fork reveals a recon error: **fix the
recon doc immediately** (dated CORRECTION block) so the following WPs don't
inherit the error.

## Final verify — two legs, not one

1. **Adversarial Sonnet session** (subscription): re-run gates, diff the
   commits vs the briefs, config/code consistency (declared commands ↔
   registered exactly once, menus ↔ contextValues), classic light-model
   failure modes (tests that assert nothing, masking mocks, swallowed
   rejections). Reports, does not fix.
2. **Live e2e by you**: a small tsx script that imports the REAL code (not the
   mocks) against the REAL daemon. Lived: caught in 1 min an MCP 406
   (`Accept` had to include `application/json, text/event-stream`) invisible
   to the 178 unit tests. Watch out for your own probes: check the real
   signature before accusing the product.

## End of session

**"Done" is declared by the repo, not by this skill.** Load the target repo's
agent-instructions file and apply it as-is — for `agentproto/ts` that's
`AGENTS.md` at the root (green gate + open PR = terminal state; never
`gh pr merge`; changeset written by the reviewer, not by hand). Do **not**
restate the rule here: this paragraph used to say `--draft` while the repo had
moved to _ready_, and the 2026-07-15 supervisor forced `--draft` onto a whole
series of PRs by trusting this skill over the source. A skill that _restates_
a rule versioned elsewhere becomes a liar at the first evolution — it
**points**, it does not restate (cf. the same fix applied to `CLAUDE.md` →
`@AGENTS.md`).

Plans are never committed, and **capitalize**: every new gotcha → memory or an
amendment to THIS skill. A supervisor session that teaches the next one
nothing is a failed one.

**Every launched session has a terminus.** launched → settled → cleaned. At
turn-end: read the output, verify the disk, then `agent_kill`. A
`running`+idle session kept around "just in case" is an orphan — 2026-07-15:
35 sessions launched, 0 clean exits. Don't poll by hand: `policy_attach`
(in-daemon, cf. `durable-supervision`) then `agentproto policy wait <id>` as a
blocking background task — that is what "push" means on the supervisor side.
