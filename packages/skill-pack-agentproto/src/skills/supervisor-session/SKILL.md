---
name: supervisor-session
description:
  Run a SUPERVISOR session with agentproto — the orchestrator (Claude,
  expensive tokens) doesn't code but keeps its hands on the wheel. Proven
  pipeline (agentproto VS Code extension, 2026-07-14) - source-verified
  scout recon → frozen SPEC + interfaces → disjoint work-package briefs →
  parallel executors (economical models) → systematic disk verification →
  single-writer consolidation → adversarial verify + live e2e → PR ("done"
  read from the target repo's AGENTS.md, never copied here). Trigger when
  the user wants to "supervise to the max while keeping the ability to act",
  have a multi-work-package deliverable built by cheap models, or
  industrialize scout→brief→execution→verify→commit. Complements
  light-coder-orchestration (model choice + Sonnet safety net) and
  durable-supervision (in-daemon policies) - this is the supervisor's
  OPERATING LOOP.
---

# Supervisor session (agentproto)

**Principle**: the supervisor holds the _plan, the contracts, and disk
truth_; the sessions hold the _work_. You don't code — EXCEPT for
consolidation and surgical fixes (1 file, known cause), because the
worktree is local: that's what "keeping the ability to act" means.

## Pipeline (roles → artifacts)

```
scout (1M-ctx model, cheap)      → recon doc VERIFIED against source (spot-check grep yourself)
you                               → SPEC.md + FROZEN interface contract + per-WP file matrix
parallel executors (cheap)       → WPs on DISJOINT scopes (briefs = .plans/ files)
you (after each turn-end)        → disk verification + targeted checkpoint commit
you (single writer)              → consolidation (shared files: extension.ts, package.json…)
verify session (Sonnet, sub)     → re-gates + adversarial diff review (doesn't fix, reports)
you                               → LIVE e2e (tsx script against the real daemon) + PR (see the repo's AGENTS.md)
```

- **WP0 foundation first, alone**: it FREEZES the interfaces (client,
  store, command ids). WP1..N code against these names without
  coordinating with each other.
- **Shared files = nobody's.** Every brief forbids `package.json` /
  `extension.ts` (equivalents) and requires in the final report: _the
  exact wiring lines + config snippets to merge_. Consolidation (you)
  applies them in a single pass and resolves collisions (e.g. two WPs
  claiming the same command → rename one).
- Briefs = files in `.plans/<project>/WPn-brief.md`; the session prompt
  contains ONLY the pointer + overrides (no-git, no-subagents,
  parallel-aware). Mandatory final report: files touched, design choices,
  wiring lines, REAL exit codes.

## Preflight (before any spawn)

1. Load the TARGET repo's agent-instructions file (not this one) — "done"
   is declared there, never here (same discipline as in End of session:
   this skill points, it doesn't copy).
2. `auth_profile_list` + `adapter_list` BEFORE any spawn: pick the
   executor's auth from the profile's METHOD — a gateway provider
   (openrouter, moonshot) wants an api-key profile (`access.profileRef`),
   never `auth:{mode:"subscription"}` (reserved for Anthropic/claude-code).
   Billing fallback when a provider is dead/flaky: OpenRouter cheap →
   claude-sdk moonshot (kimi) → claude-code `subscription` + cheap
   Anthropic (haiku), zero marginal cost. Never block the pipeline on a
   dead provider.

## Brief Contract (paste verbatim into every brief)

Paste this block as-is at the top of every executor/supervisor brief — this
is what carries the discipline through to models that load no skills at
all (hermes, OpenRouter, bare models). Don't paraphrase it, don't translate
it: a mechanical copy-paste of a skill/doc has already corrupted facts in
the past — this block must travel identical to its source.

```
- Definition of done: POINTER, never restated. Load the target repo's agent-instructions file (agentproto/ts → root AGENTS.md) and obey it verbatim: green local gate + open PR = terminal state; never `gh pr merge`; changeset written by the reviewer, not by hand; no AI attribution in commits/PR.
- Gate = exit code, never piped output: `pnpm test > /tmp/gate.log 2>&1; echo "EXIT=$?"` then grep the log. `| tail` reports tail's exit, not the gate's.
- Truth = disk, never the report. Read the actual diff; re-run the gate yourself.
- Waits are FOREGROUND/blocking, never yield-the-turn: `agentproto sessions wait <id> --until turn-end --timeout <ms>` backgrounded, or `session_monitor` (≤49s) for a quick check. A stopped agent-cli session has no timer — yielding to "wait" is a dead end.
- A wedged session (bus says awaiting-input but enqueue says mid-turn, or empty turns) → `agent_prompt interrupt:true` redirects without losing context; `agent_kill` only if truly dead (code is on disk).
- Executor auth is read from the profile's METHOD, before spawning: `auth_profile_list` + `adapter_list`. Gateway providers (openrouter/moonshot) need an api-key profile via `access.profileRef` — NOT `auth:{mode:"subscription"}`. Billing fallback when a provider is flaky/dead: OpenRouter-cheap → claude-sdk moonshot (kimi) → claude-code `subscription` + cheap Anthropic (haiku), marginal-cost-zero. Never block the pipeline on a dead provider.
```

The first bullet ("Definition of done") points to the target repo's
AGENTS.md — it doesn't replace it; adapt `agentproto/ts → root AGENTS.md`
if the target repo differs.

## Native worktree — provision + spawn in ONE move

**The DEFAULT: NEVER do `git worktree add` + `pnpm install` by hand.** Pass
the `worktree` field to `agent_start` and the daemon handles it:

- `agent_start({ cwd: <target repo>, worktree: { slug, base: "origin/main" } })`
  (or `worktree: true`, slug auto-minted from `label`). The daemon runs
  `git worktree add -b wt/<slug> … origin/main` **then plays the repo's
  `agentproto.json` setup hooks** (for `agentproto/ts`: `pnpm install
  --prefer-offline` + `pnpm build`) BEFORE spawning the adapter inside it.
  So install + build are AUTOMATIC — zero manual git/pnpm steps.
- The worktree lands OUTSIDE the monorepo (the daemon's `worktrees.root`,
  default `~/.agentproto/worktrees/<repo>/<slug>`) — which incidentally
  fixes the "worktree sibling of `ts/` → pnpm/turbo package collision"
  pitfall (worktree OUTSIDE the monorepo by construction).
- **Root only.** Only honored for a ROOT spawn; a child spawned VIA this
  orchestrator inherits the parent's tree (no second worktree) — so don't
  provision one per child. Ignored for a `sandbox` spawn (the box already
  isolates). Requires an explicit `cwd` (or `workspaceSlug`), otherwise
  `worktree_requires_explicit_repo` (no branch cut at random off the
  active workspace). A daemon policy `worktrees.isolation` (`always` /
  `never`, env `AGENTPROTO_WORKTREES_ISOLATION` > config) can force/forbid
  it globally; default `on-request`.
- **Teardown = by hand AFTER merge** (the worktree is NOT deleted when the
  session closes): `agentproto worktree rm|archive <path|slug>` (`rm`
  refuses if the tree is dirty unless
  `--discard-modified/--discard-untracked`; `archive` snapshots first
  under `~/.agentproto/worktree-salvage/`), or `agentproto worktree gc
  --apply` to sweep merged+clean+idle ones.
- **Fallback — a worktree local to YOU** (when the supervisor wants its
  OWN worktree to consolidate/edit WITHOUT spawning an agent):
  `agentproto worktree new <slug> [--base origin/main]` (creates under
  `worktrees.root`, branch `wt/<slug>`, plays the setup hooks — `--no-setup`
  to skip them) — NOT a raw hand-rolled `git worktree add`.

## Spawn protocol (hermes / OpenRouter models)

1. `agent_start` **idle** (no initial prompt!), `role: "executor"` (strips
   agent_start/agent_prompt), `cwd` = the target repo + `worktree: { slug,
   base: "origin/main" }` (see previous section — the daemon provisions +
   installs; no hand-rolled worktree).
2. `/model <slug>` alone → wait for turn-end → **verify the
   `Model switched to: <slug> · Provider: …` line** in agent_output.
3. Life ping: `Reply with exactly: READY` → non-empty turn = healthy
   session.
4. Only then, the brief.

**Why**: `/model` in the spawn prompt makes hermes FREELANCE (it explores
the repo on the expensive default model — real case: ~$1.9 for the turn,
for nothing). And an empty turn after a switch ≠ a broken session: see
Diagnostic.

For claude-code/claude-sdk: `model` + `auth {mode:"subscription"}` (or
`mode:"moonshot"` + kimi) **and `worktree`** are pinned AT SPAWN — no
/model dance, the brief can go straight into the initial prompt.

## Monitoring (token-frugal for the supervisor)

- Quick check: `session_monitor` (≤49s), fan-in via `sessionIds: [...]`.
- Long wait:
  `npx agentproto sessions wait <id> --until turn-end --timeout 2400000`
  **backgrounded** (real pitfall: timeout is in **ms** — `900` = 900 ms).
  Fan-in: a `for s in …; do wait; done` loop in a SINGLE background task.
- NEVER read the whole output: `agent_output clean lastN 40-60` after
  turn-end, that's it.

## Truth = disk, never the report

After every "green" WP: `git status --porcelain` (exact scope — nothing
out of bounds), re-run the gate YOURSELF (real exit codes), a **targeted**
checkpoint commit (`git add <paths>`, `--no-verify` if a hook sweeps up
WIP, NO push). The executor's report feeds consolidation, not trust.

## Diagnosing empty turns / "wedged" sessions

**Before** any theory about session state: `tail
~/.hermes/logs/errors.log` (or the session's events.jsonl). Real case: 3
different models "wedged" at the same time = **OpenRouter 402
Insufficient credits**; and `moonshotai/kimi-k2.7` = 400 invalid model id
(valid slug: `moonshotai/kimi-k2`). Identical symptom in both cases:
`[warning] empty turn — cost $null`.

- A queued prompt does NOT interrupt a turn; `interrupt: true` redirects
  the session without losing its context; `agent_kill` only if truly dead
  (the written code is on disk, nothing is lost).
- Billing fallback when a provider goes down: OpenRouter cheap →
  claude-sdk moonshot (kimi-k2.7-code) → claude-code `subscription` (zero
  marginal cost, Sonnet-5). Never block the pipeline on a dead provider.

## STOP-if-fork: making it real

Every brief: "uncovered design fork → STOP and ask" + likely forks named
with their default. It works (real case: the WP0 executor detected that
the recon doc invented events on `GET /events` and proposed 3 options
instead of coding against a phantom endpoint). When a fork reveals a recon
error: **fix the recon doc immediately** (a dated CORRECTION block) so
later WPs don't inherit the error.

## Final verify — two legs, not one

1. **Adversarial Sonnet session** (subscription): re-run gates, diff
   commits vs. briefs, config/code consistency (declared commands ↔
   registered once, menus ↔ contextValues), classic light-model failure
   modes (tests that assert nothing, masking mocks, swallowed rejections).
   Reports, doesn't fix.
2. **Live e2e by you**: a small tsx script that imports the REAL code (not
   mocks) against the REAL daemon. Real case: caught a 406 MCP in 1
   minute (`Accept` needed to include `application/json, text/event-stream`)
   invisible to the 178 unit tests. Watch your own probes too: verify the
   real signature before blaming the product.

## End of session

**"Done" is declared by the repo, not by this skill.** Load the target
repo's agent-instructions file and apply it as-is — for `agentproto/ts`
that's `AGENTS.md` at the root (green gate + open PR = terminal state;
`gh pr merge` never; changeset written by the reviewer, not by hand). Do
**not** copy the rule here: this paragraph once said `--draft` while the
repo had moved on to _ready_, and the 2026-07-15 supervisor forced
`--draft` on a whole series of PRs by trusting this skill instead of the
source. A skill that _restates_ a rule versioned elsewhere becomes a liar
the moment it changes — it **points**, it doesn't copy (see the same fix
applied to `CLAUDE.md` → `@AGENTS.md`).

Never commit plans, and **capitalize on experience**: every new gotcha →
memory or an amendment to THIS skill. A supervisor session that teaches
the next one nothing is a failed one.

**Every launched session has a terminus.** launched → settled → cleaned.
At turn-end: read the output, verify the disk, then `agent_kill`. A
`running`+idle session kept "just in case" is an orphan — on 2026-07-15:
35 sessions launched, 0 clean exits. Don't poll by hand: `policy_attach`
(in-daemon, see `durable-supervision`) then `agentproto policy wait <id>`
as a blocking background task — that's what "pushing" means on the
supervisor's side.
