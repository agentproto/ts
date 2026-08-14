---
name: durable-supervision
description: >-
  Supervise agents in a DURABLE way via agentproto's in-daemon policy engine:
  attach a completion policy to a session (or a fan-in group), run a gate
  (shell or judge-agent) at turn-end, emit policy:passed/failed on the event
  bus, and gate a host commit on a green gate with human ack (commit-ready →
  ack → committed). Trigger this skill when the user wants "a green gate as a
  commit condition", "attach a policy to an agent", "auto-commit when tests
  pass", "escalate to the human only if stuck", "supervision that survives
  without cowork open", or talk about RoutineRunner / notifyUrl webhook /
  judge-gate. Complements nested-orchestration (which drives agent TOPOLOGY)
  by adding the durable GOVERNANCE LAYER on top of sessions.
---

# Durable supervision (in-daemon policy engine)

The durable supervisor doesn't live in cowork (which depends on the app
staying open) but **inside the agentproto daemon**. It subscribes to session
events (`turn-end`/`awaiting-input`/`exited`), runs a **gate** at the end of
a turn, and emits the result on an **event bus** that you read without
token-hungry polling. This is the governance layer on top of sessions;
topology (who spawns whom) belongs to `nested-orchestration`, execution-model
to `light-coder-orchestration`.

Everything below has been **proven live** except sections explicitly marked
"source" (complete code + unit tests, but not re-run here).

## Principle in one line

`session → (turn-end) → gate (shell|judge) → policy:passed|failed → [then: emit | commit (human ack) → policy:committed]`

Before delegating, paste `supervisor-session`'s Brief Contract into every
brief.

## 1. Attaching a policy to a session

```
policy_attach({
  sessionId: "sess_xxx",        // OR sessionIds:[...] for a fan-in group
  then: "emit",                  // "emit" → policy:passed/failed ; "commit" → stage+commit
  gate: { command, args?, cwd?, timeoutMs? },   // shell: exit 0 = pass
  onFail?: { nudge?, maxRetries? },             // re-prompt N times then blocked
  next?: <policy>                                // DAG: chains a policy on done (source)
})
```

- Proven lifecycle: `watching` → (turn-end) `gating` → `done` (green) /
  `blocked` (red, no retries left) / `awaiting-ack` (commit). Read it via
  `policy_status({policyId})`; inventory via `policy_list()`.
- The gate runs **after the `turn-end`** of the watched session. **Attach
  the policy BEFORE the session finishes its turn** (spawn idle → attach →
  prompt), otherwise you run the same race risk as `wait_for_any` (the
  transient event can be missed).
- **No gate** → the policy passes immediately at turn-end (useful just to
  mark a completion on the bus).

## 2. The shell gate — two real-world invariants

The shell gate is `{ command, args?, cwd?, timeoutMs? }`, exit 0 = pass.
**Two pitfalls proven live**:

1. **Allowlist.** The gate goes through the same allowlist as
   `command_execute` (`<workspace>/.agentproto/allowed-commands.json`,
   default-deny). A gate `test -f x` failed with `gate command 'test' not
   in allowlist` → policy `blocked`. Use an allowlisted binary (`ls`,
   `cat`, `git`, `node`, `pnpm`, `npm`, `npx`, `gh`, `echo`, `bash`…). For
   "does the file exist?" → `ls <file>` (not `test -f`). For a test gate →
   `pnpm`/`npm`/`node` depending on the project.
2. **cwd anchored to the workspace.** The gate's cwd **defaults to the
   watched session's cwd**, but it's **anchored to the workspace**: a
   session whose cwd is OUTSIDE the workspace makes the gate fail with
   `cwd escapes the workspace`. Workaround: launch the watched session
   **inside the workspace**, or pass an explicit workspace-relative
   `gate.cwd` (e.g. `"."` or `"sub/folder"`).

Proven green gate: `policy:passed`, status `done`, `lastGate.exitCode:0`.

**⚠️ In practice (learned the hard way, repeated 2× in the same
orchestration session, 2026-07-01): for the dominant "dedicated worktree
per feature" pattern — now provisioned NATIVELY via `agent_start({
worktree: … })` (the daemon does `git worktree add` + the setup hooks), not
a hand-rolled `git worktree add`; the worktree lives under
`worktrees.root` (default `~/.agentproto/worktrees`), an absolute cwd
OUTSIDE `agentik-studio` — shell gates are essentially UNUSABLE.** The
anchored workspace is YOUR OWN calling context's (the orchestrator's), not
the target session's — so even an explicit absolute `cwd` at spawn fails
systematically, immediately (`status: blocked`, `retries: 0` — NOT a case
handled by `onFail`, it's an infra error, not an exit code). Worse: the
failure is **silent** — the policy goes to `blocked` without notifying you;
you only discover it by calling `policy_status` yourself, which defeats the
whole point of the primitive (supervising without polling).

**What works instead, for any out-of-workspace worktree**:

1. `policy_attach({ sessionId, then: "emit" })` **without `gate`** — always
   passes at turn-end, just useful to know WHEN the turn finished (no
   content verification).
2. Verify the result **yourself**, outside agentproto, with your own shell
   tools (`git log`, `git merge-base --is-ancestor`,
   `gh pr view --json mergeable`, `pnpm test` directly) — NOT with a
   `policy_attach` gate.
3. Do NOT trust a session's self-report without this independent
   verification (see also the `agent-session-orchestration-agentproto`
   skill, "Delegating a real PR-worktree" section).

## 3. Judge-agent gate (source — WP7)

Instead of a shell,
`gate: { judge: { adapter, model?, prompt, timeoutMs? } }` spawns a short
LLM agent that judges the watched session's output and ends with
`VERDICT: PASS|FAIL` (last occurrence, case-insensitive). **Fail-safe**:
timeout or an unparseable response = FAIL. The judge is **always killed**
once the gate resolves, and it occupies a concurrency slot while running.
Useful for a qualitative criterion ("does the diff follow the style?")
that no exit code captures.

## 4. Green gate as a commit condition (proven end-to-end)

`then: "commit"` turns a green gate into a **governed host commit**:

```
policy_attach({
  sessionId, then:"commit",
  gate: { command:"ls", args:["hello.txt"], cwd:"." },
  commit: { paths:["hello.txt"], message:"…", requireHumanAck: true }
})
```

- Stages **strictly** `commit.paths` via `git add -- <paths>` (never `-A`,
  never a glob; empty `paths` = rejected at attach time), then
  `git commit -m` (argv, `shell:false` — no injection). **Never a push,
  never `--force`.**
- `requireHumanAck: true` (default): green gate → status `awaiting-ack` +
  event **`policy:commit-ready`** (with `paths`, `message`,
  `commitPlan.cwd`). The commit **does not go out** until
  `policy_ack({ policyId, approve:true })` is called → runs the commit →
  **`policy:committed` (+ sha)** → `done`. `approve:false` cancels without
  committing.
- `requireHumanAck: false`: commits directly on green (still never a push).
- **Prerequisite**: `git` allowlisted + a git repo with
  `user.name`/`user.email` configured at the commit cwd. Proven sequence:
  `gate exit 0 → policy:commit-ready (awaiting-ack) → ack(approve:true) → policy:committed sha=…`,
  verified with `git log` (1 file, 1 insertion).

## 5. Reading progress without polling — the event bus

`session_events_poll({ since, types?, sessionIds?, limit? })`: a
**cursor** snapshot of events since the last call (no transcript, so
cheap). Useful types: `turn-end`, `awaiting-input`, `exited`,
`command-done`, `policy:passed`, `policy:failed`, `policy:commit-ready`,
`policy:committed`. Grab a cursor (`nextCursor`) **before** triggering,
re-read after. To **block** efficiently on an imminent completion,
`session_monitor`; for a state **sweep** between two actions,
`session_events_poll`.

## 6. Human escalation via webhook (source)

`webhook-notifier.ts` POSTs an event to target URLs (per-session
`notifyUrl` passed at spawn **+** global `AGENTPROTO_NOTIFY_URL` /
`~/.agentproto/notify.json`, env wins, deduplicated). Fire-and-forget: 10s
timeout, **one** retry after 2s on network error, no retry on 4xx/5xx,
never throws in the hot path. Triggered on `turn-end` / `awaiting-input` /
`exited` (payload: `sessionId`, `label`, `event`, `awaitingInput`, `ts`, +
`exitCode`/`status` at exit). This is the "let me know when an agent is
waiting" seam without cowork open.

## 7. Per-step waiting policy (`workflow_start`)

> **RoutineRunner and its shim have been removed (Phase B2 then B3).** The
> `routine_start`/`routine_status`/`routine_cancel`/`routine_escalation_resolve`
> tools and the `/routines/*` run routes no longer exist — use
> `workflow_start`/`workflow_status`/`workflow_cancel`/
> `workflow_escalation_resolve`. `waitFor` (external fan-in) has no
> workflow equivalent; express fan-in via parallel stages instead.

Each step of a `workflow_start` stage can carry a **policy** for what
happens if its session requests input mid-stage:

- `auto-allow` (+`prompt`): answers on its own and continues.
- `escalate` (+`webhookUrl?`, `timeoutMs?` default 5 min): POSTs the
  webhook then waits for an external
  `workflow_escalation_resolve({ runId, stageIndex, stepIndex, response })`;
  timeout = failure.
- `fail`: marks the step/run as failed.

This is "an agent babysitting another by playing the human **and only
escalating if stuck**" (cf. the live babysit pattern in
`nested-orchestration`, made durable here). Runs are persisted
(`~/.agentproto/workflow-runs.json` by default) — a daemon restart does not
lose an in-progress run.

## 8. When to use what

- **A completion to mark / a test gate** → `policy_attach then:emit` +
  `session_events_poll`.
- **Commit governed by a green gate** → `policy_attach then:commit` +
  `requireHumanAck` + `policy_ack`.
- **Several chained steps** → `next` (a drivable policy DAG) or
  `workflow_start` (single-step stages) — `routine_start`/`routine_*` (the
  old RoutineRunner) have been removed, see §7.
- **Qualitative criterion** → `judge` gate.
- **Notify a human when it's waiting/stuck** → `notifyUrl` (per-session) or
  global.
- **Staying at work ACROSS several conversation turns, with no user
  re-prompt and no replanning drift** →
  `agentproto sessions wait --policy <id> --timeout <ms>` in a
  `Bash run_in_background:true` (§9) — NOT looping
  `session_monitor`/`session_events_poll` (doesn't survive your turn
  ending) nor `/loop`+`ScheduleWakeup` alone (self-replanned, can drift).

## 9. Waiting ACROSS conversation turns (not just within one)

Learned in real use 2026-07-01/02, a direct user question: "how can I be
SURE you keep working without me having to come back and relaunch you?".
Crucial distinction between two notions of "waiting":

- **`session_monitor`/`session_events_poll`/`agentproto sessions wait`
  called directly**: block for at best ~45-49s per call (the MCP transport
  cuts off at ~60s server-side) — and crucially, that block lives **within
  YOUR active turn**. As soon as your turn ends, no wait is running
  anymore; nothing hands you back control until the user sends a new
  message.
- **`ScheduleWakeup` (`/loop`)**: gives a real autonomous re-invocation,
  but it's **self-scheduled by you** — you have to call the tool again on
  every tick, which can drift/silently stop, and it requires the user to
  have launched `/loop` in the first place.
- **The real reliable hook, discovered while looking for one tonight:
  `Bash` with `run_in_background: true`.** Any backgrounded command
  triggers an AUTOMATIC harness notification on exit — a native mechanism,
  zero self-replanning, zero drift.
  `agentproto sessions wait <id-or-name> [--policy <policyId>] --timeout <ms> --json`
  does exactly the same internal ~50s-slice loop (same REST endpoint
  `/policies/:id/wait` / `/sessions/:id/wait` as
  `session_monitor`/`session_events_poll` — **no different server
  capability**, just the fact that it's an AUTONOMOUS OS PROCESS you can
  background), but because it's a separate process, the harness notifies
  you when it exits, EVEN across turns.

```bash
agentproto sessions wait --policy policy_xxx --timeout 2400000 --json
# launched via Bash run_in_background:true → automatic notification on return,
# no /loop, no user re-prompt, no replanning drift.
```

This is NOT "CLI over MCP" as a general rule — it's specific to the CASE
of "waiting a long time, across turns". For everything else (spawn,
prompt, list, attach) MCP remains the right tool; it's only this
long-duration wait that benefits from a backgroundable OS process rather
than a plain synchronous tool call within your turn.

## Gotchas (real-world + source)

- **Attach race**: attach the policy **before** the session's turn-end
  (spawn idle → attach → prompt). Otherwise the event can be missed.
- **`test` is not allowlisted**; `ls`/`cat`/`git`/`node`/`pnpm`/`echo`/`bash`
  are. Adapt the gate to the workspace's allowlist.
- **`cwd escapes the workspace`**: the watched session (or `gate.cwd`)
  must be **inside** the workspace. Sessions launched in an out-of-workspace
  scratch dir aren't gateable as-is. **In practice for agentproto/ts
  (worktree per feature): don't even try a shell gate, use `then:"emit"`
  without `gate` and verify yourself via `git`/`gh`** (see §2 above,
  detailed gotcha).
- **Isolated commit for testing**: NEVER test `then:commit` in the working
  repo — the workspace root IS often a real repo. `git init` a disposable
  repo **inside** the workspace (cwd doesn't escape), test, then `rm -rf`.
- **onFail**: without `onFail`, a red gate → immediate `blocked`. With it,
  the session is re-prompted (`nudge`, `{code}` = exit code) up to
  `maxRetries` (default 2) then `blocked` — the session must **still be
  running** to receive the nudge.
- **RoutineRunner removed**: see §7 — the imperative engine (Phase B2) and
  its `routine_*` alias (Phase B3) have both disappeared; use
  `workflow_*`.

## Durable supervision checklist

- [ ] Watched session **inside the workspace** (cwd doesn't escape)
- [ ] Gate with an **allowlisted** binary (`ls` not `test`, `pnpm`/`node`
      for tests)
- [ ] Policy attached **before** turn-end (spawn idle → attach → prompt)
- [ ] `then:emit` to mark / `then:commit` + `requireHumanAck` to commit
- [ ] Commit: explicit `paths`, repo + `user.name/email`, **isolated repo**
      if testing
- [ ] Tracked via `session_events_poll` (cursor); `policy_ack` to release a
      commit
- [ ] `notifyUrl` escalation only if you want to be notified
      (blocked/waiting)
