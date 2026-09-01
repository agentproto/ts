---
name: ap-policies
description: Attach a completion policy gate (shell check or judge-agent rubric) to a session or fan-in group so turn-end only passes when the gate is green, then optionally auto-commit pending human ack. Use when the user says "gate this session on tests passing", "attach a policy", "commit only if tests are green", "judge whether this is done", "approve the pending commit".
---

# Completion Policies

## When to use

Use `ap-policies` to gate a session (or fan-in group) at turn-end by an
objective check — a shell command's exit code or a judge sub-agent's verdict
— instead of trusting the agent's own "done" claim, and/or to auto-commit
once that gate is green, pending an explicit human ack.

## MCP tool: policy_attach

Attach a gate to one `sessionId`, or a `sessionIds` array for a fan-in group
(the policy resolves once ALL sessions in the group reach turn-end). The gate
is either a shell command (basename must be allowlisted, see ap-run-command)
or a judge `adapter` + `prompt`. `then` decides what happens on pass: `emit`
(just publish `policy:passed`) or `commit` (stage + commit specific paths,
gated by `requireHumanAck`). `onFail` controls retries with a nudge prompt.
`next` chains another policy as a DAG.

```json
{
  "tool": "policy_attach",
  "args": {
    "sessionIds": ["sess_a1b2", "sess_c3d4"],
    "gate": { "command": { "name": "pnpm", "args": ["test:unit"] } },
    "then": "commit",
    "commit": {
      "paths": ["services/api-gateway/src/routes/webhook.ts"],
      "message": "fix: validate webhook signature before dispatch",
      "requireHumanAck": true
    },
    "onFail": { "nudge": "tests still red — fix the failing assertions", "maxRetries": 3 }
  }
}
```

Judge gate variant:
```json
{
  "tool": "policy_attach",
  "args": {
    "sessionId": "sess_a1b2",
    "gate": {
      "judge": {
        "adapter": "claude-code",
        "prompt": "Does the diff add a test for the new webhook signature check? Answer pass/fail with one reason."
      }
    },
    "then": "emit"
  }
}
```

## MCP tools: policy_status / policy_list

`policy_status` polls state (`pending` | `passed` | `failed` |
`awaiting_ack`) plus `awaitingQuestions` — judge follow-ups blocking
resolution. `policy_list` lists active/recent policies, optionally filtered
by `sessionId`.

```json
{ "tool": "policy_status", "args": { "policyId": "pol_9f21" } }
{ "tool": "policy_list", "args": { "sessionId": "sess_a1b2" } }
```

## MCP tool: policy_ack

Approve or reject a parked commit once the gate passed and
`requireHumanAck: true` held it. Approving runs `git add` + `git commit` with
the exact paths given at attach time — never `-A`, never a push.

```json
{ "tool": "policy_ack", "args": { "policyId": "pol_9f21", "approve": true } }
```

## MCP tool: policy_cancel

Cancel a policy before it resolves: `{ "tool": "policy_cancel", "args": { "policyId": "pol_9f21" } }`.

## Gate semantics

A shell gate passes on exit 0, fails otherwise. A failed gate re-prompts the
target session up to `onFail.maxRetries` times using `onFail.nudge`, then
settles to `policy:failed`.

## Gotchas

- A judge gate spawns a real sub-agent to evaluate the rubric — keep the
  prompt short and binary (pass/fail + one reason); long rubrics burn tokens
  and drift off-topic.
- `commit` requires `git` in the command allowlist
  (`<workspace>/.agentproto/allowed-commands.json`) and defaults to
  `requireHumanAck: true` — nothing lands without an explicit `policy_ack`.
- Fan-in groups resolve only once every session in `sessionIds` reaches
  turn-end; one stuck session blocks the whole gate.
- `next` chains are DAGs, not loops — a failed upstream policy does not retry
  a downstream one.

## Pointers

- ap-spawn-agent — start the session(s) you're about to gate.
- ap-wait-fanin — wait on a fan-in group directly instead of gating it.
- pb-boss-checkins — periodic re-prompt cadence, complementary to onFail retries.
- extend-agentproto — building custom judge adapters or gate commands.
