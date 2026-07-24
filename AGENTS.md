# Agent instructions for this repo

This file is the committed definition of done for any agent session working
in `agentproto/ts` — local or delegated, human-prompted or supervisor-run.
If you're an agent reading this from a prompt instead of loading it, stop:
load this file first, it overrides ad-hoc instructions.

Not to be confused with: an AIP-42 agent manifest (also named `AGENT.md`,
singular, loaded from `<workspace>/.agents/<id>/AGENT.md` —
`packages/agent/src/schema.ts:2`), or `.github/AGENT.md`, the cloud
reviewer/fixer harness that runs on every PR — see that file for what it
does; this file is about what *you* (the session driving the work) must do
before and around it.

**Reach:** this is a convention, not enforcement. It binds local and
delegated coding sessions that load it — nothing in the daemon reads it, and
the cloud reviewer doesn't either (it runs on `.github/AGENT.md` + the
`aip-conventions` skill from `.github/agentic-review.json`). Loading this
file is still on the session; it doesn't reach in and gate anything by
itself.

## Definition of done for agent sessions

**Done = a green local gate + an open PR. That is the terminal state for an
agent session — the handoff, not a request for permission.** Your rung ends
there; review, risk-judgement, escalation, and merge are the CI plane's job,
already declared in `.github/agentic-review.json` + `.github/workflows/ci.yml`.
Each rung has exactly one owner — don't reach into the next one.

1. **Green gate.** Run this repo's own gate before calling anything done:
   `agentproto.json` declares `scripts.test` as `pnpm test`
   (`agentproto.json:5`, itself `pnpm -r --filter "./packages/**" --filter
   "./adapters/**" test`, `package.json:18`). Don't invent your own bar.

   **Read the gate's exit code, not its output.** `pnpm test | tail -30`
   reports **`tail`'s** exit status, not the test run's — a pipeline exits
   with its LAST command's status, so a red gate reads as exit 0 and you
   will report a passing gate that failed. `${PIPESTATUS[0]}` does not
   rescue it either: that's bash, and this repo's sessions run zsh, where
   it's `$pipestatus[1]` and the bash spelling silently expands to empty.
   Redirect and check `$?` directly:

   ```sh
   pnpm test > /tmp/gate.log 2>&1; echo "EXIT=$?"   # then grep the log
   ```

   **`pnpm test` is necessary but not sufficient — the CI gate is `pnpm test`
   AND `pnpm check-types`.** `check-types` (`tsc --noEmit`) runs as its own CI
   job; Vitest transpiles without type-checking, so a type error in a **test
   file** sails through `pnpm test` and only fails in CI (this bit an executor:
   a mistyped `vi.spyOn` mock passed the local gate, reddened CI). Run both,
   each read by its own real exit code:

   ```sh
   pnpm check-types > /tmp/ct.log   2>&1; echo "CT_EXIT=$?"
   pnpm test        > /tmp/gate.log 2>&1; echo "TEST_EXIT=$?"
   ```

   (Add `pnpm lint` too if the package defines it.)

   Same trap for a backgrounded gate: the harness reports the exit code of
   the whole compound command, so end it with the real status
   (`echo "EXIT=$?"`) rather than trusting the completion notification.

   **Never end your turn to "wait" for backgrounded work.** Backgrounding
   the gate (`pnpm test &`, a detached Terminal/PTY) and then yielding so
   you can "check back later" is a dead end, not a pause: a stopped
   agent-cli session has no timer and no completion hook of its own, and
   `policy_attach` can't rescue you either — a lone watched session's
   `exited` event cancels a completion policy instead of completing it
   (`packages/runtime/src/supervisor.ts:1028-1061`), so attaching one to
   yourself before yielding doesn't wake you back up. The session sits
   there indefinitely, looking alive in `session_list` but never
   re-prompted, until a human happens to notice. Run the gate in the
   foreground and block on its real exit code instead. If a gate is
   genuinely too long for one turn, that's a job for whoever is
   supervising you to gate on your turn-end from the outside, not for you
   to background-and-hope.

   **A fresh worktree needs `pnpm install` AND `pnpm build` before the gate
   is meaningful.** Packages import each other's built `dist/`, so an
   unbuilt worktree fails in packages you never touched (`Failed to resolve
   entry for package "@agentproto/…"`, `Cannot find package 'zod'`). That is
   your worktree, not the code. `pnpm install --filter <pkg>...` installs
   only one subgraph and leaves the rest of the monorepo unrunnable — so if
   you intend to run the full gate, do a full install. Before blaming a
   failure in a package your diff doesn't touch, re-run it on `main`: if it
   passes there, the fault is your tree.

   `agentproto worktree new` now does both for you — `worktree.setup` in
   `agentproto.json` runs the install *and* the build, so a worktree it
   provisions arrives gate-ready. A worktree made by bare `git worktree add`
   still needs both by hand.

   **Share the build cache across worktrees: export `TURBO_CACHE_DIR`.**
   `pnpm build` runs through turbo, whose filesystem cache otherwise lives in
   each worktree's own `.turbo/` — so every worktree rebuilds all ~103 tasks
   from cold (~53s) even when another worktree already built the identical
   inputs. Pointing every worktree at one directory turns that into a cache
   restore, and a hit needs no `node_modules` at all: turbo just unpacks
   `dist/`. CI shares the same artifacts over the remote cache
   (`TURBO_API`/`TURBO_TEAM`/`TURBO_TOKEN`, see `.github/workflows/ci.yml`);
   `TURBO_CACHE_DIR` is the local, offline, zero-credential equivalent.
2. **Open the PR.** `gh pr create` — ready, not draft. A ready PR is the
   point: it hands off into the declared flow (agentic review → `APPROVED` →
   maintainer judge → `alwaysEscalateGlobs` escalating migrations/auth/
   workflows/SQL/env to a human automatically → auto-merge). Use `--draft`
   only for genuinely uncertain/WIP work, or when a human explicitly asked
   for a look first — it's the exception, not the default.

**Never run `gh pr merge`.** This is the one hard line, and it's about not
bypassing the declared flow, not deference for its own sake. Merge
conditions — review decision, the maintainer's risk judgement, the
always-escalate paths, the auto-merge switch — are read from the **base
branch**, deliberately out of any PR's reach (`.github/workflows/ci.yml:471`
comment, switch logic `:538-556`; "a PR gets no vote on how it is merged",
commit `4d5dca1` / #343). The only thing that enables auto-merge at all is
the repo variable `vars.AGENTFLOW_AUTOMERGE`, set in repo settings — a PR,
and therefore an agent, cannot reach it either way. An agent running
`gh pr merge` under ambient `gh` credentials routes around every one of
those gates. That is exactly the 2026-07-15 incident this file exists to
prevent.

**Don't hand-write a changeset.** The agentic reviewer writes it for you as
part of its automatic pass on every PR push (`.github/workflows/ci.yml:211`
region, commit step at `:298-322`) — a hand-written one is redundant and the
`changeset-check` job (`ci.yml:60-94`) doesn't need one from you: it only
requires *a* changeset to exist before merge, and only when
`packages/**`/`adapters/**` changed. Docs-only changes (like this file) need
no changeset at all (`ci.yml:87-90`).

**Don't stamp `[agentflow-reviewed]`** in a commit message, and don't run
`review:ai --stamp` locally, unless a human explicitly told you to. That
marker makes the cloud reviewer skip its pass entirely
(`.github/workflows/ci.yml:275`) — it's a convenience for a human who already
ran and read a local review, not something to reach for on your own.

**No AI attribution in commits or PR bodies.** No `Co-Authored-By: Claude
...`, no `Generated with ...`, no equivalent trailer. `hygiene-check`
enforces this on every PR (`.github/workflows/ci.yml:104-165`, pattern at
`:131`) and fails the check if one rides in.

## Recipes: gates you can declare today

These are already possible through the supervisor's completion-policy engine
(`policy_attach` MCP verb / `POST /policies` REST route,
`packages/runtime/src/orchestration-tools.ts:938`,
`packages/runtime/src/http-server.ts:2902-2951`) — they just aren't written
down anywhere else. These use today's verb names (`policy_*`, `policy_attach`,
`policy_status`, `policy_ack`, `policy_cancel`, `policy_list`) — that's the
real surface, not a placeholder for something else.

- **CI-status gate.** Wait for a PR's checks as a shell gate:
  ```json
  { "command": "gh", "args": ["pr", "checks", "<pr-number>", "--watch"] }
  ```
  `gh` must be in the workspace's `.agentproto/allowed-commands.json` for
  this to run (`packages/runtime/src/command-tools.ts:54`). Each attempt caps
  out around 10 minutes; if your CI run is longer, lean on `onFail` retries
  as a poor-man's poll rather than expecting one attempt to cover a full run.

- **Review-accepted gate.** A shell gate only understands exit codes, and
  `gh pr view` always exits 0 regardless of the decision — so wrap it:
  `gh pr view <pr-number> --json reviewDecision --jq 'if .reviewDecision ==
  "APPROVED" then 0 else error("not approved") end'` (or a one-line script)
  turns "reviewDecision is APPROVED" into a real pass/fail for the gate.

- **Human-ack before merge.** `.github/agentic-review.json` already supports
  `merge.requireAck` + `merge.ackLabel: "agentflow:ack"`
  (`agentic-review.json:14-15`). It exists and works, it's just off by
  default in this repo — don't assume it's gating anything unless you've
  checked the current config.

- **Risk fail-safe on merge.** `merge.alwaysEscalateGlobs` + the maintainer
  judge (`scripts/maintainer.mjs:85-119`) already escalate anything touching
  migrations, SQL, auth, security, workflows, or `.env*` files to a human
  instead of auto-merging — this one is ON today and observed working. As of
  `#343`, the merge job also runs its own deterministic guard ahead of the
  maintainer: a PR touching the merge machinery itself (`.github/workflows/**`,
  `.github/agentic-review.json`, `.github/actions/**`, `scripts/maintainer.mjs`,
  `scripts/agentflow/**`) is escalated outright, precisely because that
  machinery can't be trusted to judge changes to itself (`ci.yml:558-579`).
  You don't need to build risk-scoping; it's there.

- **Chaining, fan-in, and long-poll.** A policy's `next` field chains a
  fresh completion policy once the current one reaches `done`
  (`supervisor.ts` `AttachPolicyInput.next`, DAG chaining WP6); `sessionIds`
  makes a gate fan-in and run once only after every listed session finishes
  its turn; a gate can be a judge agent instead of a shell command
  (`JudgeGateSpec`, `packages/runtime/src/supervisor.ts:127-148`); and
  `GET /policies/:id/wait` (`http-server.ts:2902-2951`) is a blocking
  long-poll if you'd rather not spin a gate loop yourself.
\n
- **Supervising other sessions without a self-timer.** If you spawn a child
  session and must wait on it across your own turns, do NOT self-park with an
  in-process timer (a harness `ScheduleWakeup` dies with the process, and the
  idle-reaper will retire a session that merely *looks* idle). Background the
  daemon-owned wait instead — `agentproto sessions wait <child> --until
  turn-end --timeout 2h` as a detached process (it survives your turn and the
  harness pings you on exit; a bare integer `<1000` is rejected, so write `2h`
  not `2`). Two session flags back this up: set `keepAlive` at spawn (or the
  `session_set_keepalive` verb) so a legitimately-parked supervisor is exempt
  from the idle-reaper, and set `restartPolicy` so an agent-cli child that
  *crashes* (now detected → `endedReason:"crashed"`, surfaced with a
  `[crashed]` line + `session:exited`) is auto-restarted with backoff + a
  crash-loop cap, resuming its context in place. A crashed child spawned with
  `notifyParentOnCrash` also signals its (idle) parent. Prefer these over any
  timer you hold yourself.
