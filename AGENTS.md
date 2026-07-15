# Agent instructions for this repo

This file is the committed definition of done for any agent session working
in `agentproto/ts` — local or delegated, human-prompted or supervisor-run.
If you're an agent reading this from a prompt instead of loading it, stop:
load this file first, it overrides ad-hoc instructions.

See also `.github/AGENT.md` for the cloud reviewer/fixer that runs on every
PR — this file is about what *you* (the session driving the work) must do
before and around that.

## Definition of done for agent sessions

**Done = a green local gate + a draft PR. That is the terminal state for an
agent session. Nothing further is yours to do.**

1. **Green gate.** Run this repo's own gate before calling anything done:
   `agentproto.json` declares `scripts.test` as `pnpm test`
   (`agentproto.json:5`, itself `pnpm -r --filter "./packages/**" --filter
   "./adapters/**" test`, `package.json:18`). Don't invent your own bar.
2. **Open a draft PR.** `gh pr create --draft`. Never anything else.

**Never run `gh pr ready` or `gh pr merge`.** Flipping a PR ready and merging
it belong to the operator and to the CI merge config
(`.github/agentic-review.json`, `.github/workflows/ci.yml`), not to a
session. This is not a style preference — a direct merge under an
ambient-credentialed actor is exactly the failure this file exists to
prevent. If your gate is green and the PR is a draft, you are done; wait for
a human or the pipeline to take it from there.

**Don't hand-write a changeset.** The agentic reviewer writes it for you as
part of its automatic pass on every PR push (`.github/workflows/ci.yml:201`
comment, commit step at `:291-315`) — a hand-written one is redundant and the
`changeset-check` job (`ci.yml:53-89`) doesn't need one from you: it only
requires *a* changeset to exist before merge, and only when
`packages/**`/`adapters/**` changed. Docs-only changes (like this file) need
no changeset at all (`ci.yml:75-80`).

**Don't stamp `[agentflow-reviewed]`** in a commit message, and don't run
`review:ai --stamp` locally, unless a human explicitly told you to. That
marker makes the cloud reviewer skip its pass entirely
(`.github/workflows/ci.yml:268`) — it's a convenience for a human who already
ran and read a local review, not something to reach for on your own.

**No AI attribution in commits or PR bodies.** No `Co-Authored-By: Claude
...`, no `Generated with ...`, no equivalent trailer. `hygiene-check`
enforces this on every PR (`.github/workflows/ci.yml:97-158`, pattern at
`:124`) and fails the check if one rides in.

## Recipes: gates you can declare today

These are already possible through the supervisor's completion-policy engine
(`policy_attach` MCP verb / `POST /policies` REST route,
`packages/runtime/src/orchestration-tools.ts:938`,
`packages/runtime/src/http-server.ts:2902-2951`) — they just aren't written
down anywhere else. All use today's verb names (`policy_*`); see
[Naming](#naming-note) below for what's changing later.

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
  judge (`scripts/maintainer.mjs:75-110`) already escalate anything touching
  migrations, SQL, auth, security, workflows, or `.env*` files to a human
  instead of auto-merging — this one is ON today and observed working. You
  don't need to build risk-scoping; it's there.

- **Chaining, fan-in, and long-poll.** A policy's `next` field chains a
  fresh completion policy once the current one reaches `done`
  (`supervisor.ts` `AttachPolicyInput.next`, DAG chaining WP6); `sessionIds`
  makes a gate fan-in and run once only after every listed session finishes
  its turn; a gate can be a judge agent instead of a shell command
  (`JudgeGateSpec`, `packages/runtime/src/supervisor.ts:127-148`); and
  `GET /policies/:id/wait` (`http-server.ts:2902-2951`) is a blocking
  long-poll if you'd rather not spin a gate loop yourself.

## Naming note (forward-looking, not yet true)

A later PR renames the supervisor's completion-policy concept from
**policy** to **contract** (a CLI verb `agentproto contract ...` ships with
it) — the MCP verbs above (`policy_attach`, `policy_status`, `policy_ack`,
`policy_cancel`, `policy_list`) are what exists *today*. Don't invoke
`contract_*` verbs or a `contract` CLI command until that PR lands.
