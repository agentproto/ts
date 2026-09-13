# `agentproto policy`

```text
agentproto policy attach (--session <id> | --sessions <id,id,…>)
                         [--then emit|commit]
                         [-- <gate-cmd> [args...]]
                         [--gate-cwd <dir>] [--gate-timeout <duration>]
                         [--judge-adapter <slug> --judge-prompt <text>
                            [--judge-model <id>] [--judge-timeout <duration>]]
                         [--gate-json <json|@file>]
                         [--commit-path <path>]... [--commit-message <text>]
                         [--ack | --no-ack]
                         [--on-fail-nudge <text>] [--on-fail-max-retries <n>]
                         [--attach-json <json|@file>]
                         [--wait] [--timeout <duration>] [--json]
agentproto policy status <policyId> [--json]
agentproto policy wait   <policyId> [--timeout <duration>] [--json]
agentproto policy ack    <policyId> (--approve | --reject) [--json]
agentproto policy ls     [--session <id>] [--json]      (alias: list)
agentproto policy cancel <policyId> [--json]
```

Timeout/interval-style flags accept a duration string: `500ms`, `30s`, `5m`, `2h`.
A bare integer is still interpreted as milliseconds (back-compat), but a bare
integer under 1000 is rejected as ambiguous — use `30s` or `30ms` explicitly.

CLI surface for the daemon's **completion-policy engine** — shell/judge gates,
commit + human-ack, retry-on-fail, DAG chaining. A policy attaches to a session
and decides what happens when its turn ends: run a gate, and on green either
emit the result or commit it.

A pure HTTP client over the `/policies` routes — the same engine the
`policy_attach` / `policy_status` / `policy_cancel` / `policy_ack` /
`policy_list` MCP tools drive. Requires a running daemon
([`serve.md`](./serve.md) or [`daemon.md`](./daemon.md)).

## Gate forms

`attach` takes **at most one** gate; passing two exits `2`. No gate at all
means the policy passes immediately at turn-end.

| Form | How | Passes when |
|------|-----|-------------|
| Shell | `-- <cmd> [args...]` — argv passthrough, same idiom as `sessions terminal -- <argv>` | The command exits `0`. |
| Judge | `--judge-adapter <slug> --judge-prompt <text>` | A short-lived judge agent says so. |
| Verbatim | `--gate-json <json\|@file>` | Escape hatch: either shape, sent as-is. |

`--gate-cwd` / `--gate-timeout` apply to a shell gate only — passing them
without `-- <cmd>` exits `2`. `--gate-timeout` and `--judge-timeout` use the
same duration format as `--timeout` (`30s`, `5m`, ...; bare integer = ms).

## `attach`

| Flag | Default | Description |
|------|---------|-------------|
| `--session <id>` | — | The session to gate. One of this or `--sessions` is required. |
| `--sessions <id,id,…>` | — | Fan-in: the gate runs once, after **every** listed session finishes its turn. |
| `--then emit\|commit` | `emit` | What a green gate does. |
| `--commit-path <path>` | — | Path to commit; repeatable. Required with `--then commit`. |
| `--commit-message <text>` | — | Commit message. Required with `--then commit`. |
| `--ack` / `--no-ack` | `--ack` | With `--then commit`: park the commit in awaiting-ack until `policy ack --approve` (default), or commit directly on a green gate (`--no-ack`). Mutually exclusive. |
| `--on-fail-nudge <text>` | — | On a red gate, nudge the session with this text and re-run. |
| `--on-fail-max-retries <n>` | — | Cap the retries. Must be ≥ 1. |
| `--attach-json <json\|@file>` | — | Sent as the **entire** POST body, ignoring every other attach flag. The full recursive shape — fan-in `sessionIds`, `next` chaining, judge-gate detail — when flags get unwieldy. |
| `--wait` | `false` | Block on the new policy (like `policy wait`) before returning. |
| `--timeout <duration>` | `900000` | With `--wait`: total wait ceiling. Accepts `500ms`, `30s`, `5m`, `2h`; bare integer = ms, but bare integers `<1000` are rejected as ambiguous. |
| `--json` | `false` | Emit the `PolicyRunState` as JSON. |

The commit flags (`--commit-path`, `--commit-message`, `--ack`, `--no-ack`)
only apply with `--then commit`; passing them alongside `--then emit` exits `2`
rather than silently ignoring them.

### Judge gate details

A judge gate spawns a short-lived adapter session, waits for its answer, and
treats the reply as a pass/fail verdict. The legacy plain-text form still
works: the judge can end with a line `VERDICT: PASS` or `VERDICT: FAIL`.

Since WP-D the judge may also return a **structured JSON verdict** (usually
inside a fenced ` ```json ... ``` block):

```json
{
  "decision": "PASS",
  "summary": "No issues found",
  "findings": [
    { "severity": "medium", "file": "src/auth.ts", "note": "missing input validation" }
  ]
}
```

The engine uses only `decision` for the gate outcome; `summary` and `findings`
are persisted and echoed on `policy:passed`/`policy:failed` events so operators
can see *why* a gate failed. Severities are `info | low | medium | high | critical`;
which severity blocks is up to the judge's own prompt.

When building the gate via `--attach-json` / MCP / HTTP, the `judge` object
accepts the CLI flags (`adapter`, `model`, `prompt`, `timeoutMs`) plus:

| Field | Meaning |
|-------|---------|
| `judge.access.profileRef` | Pin the judge spawn to a named auth profile instead of the daemon's ambient wallet. |
| `judge.route` | Route identity for the judge spawn (consulted together with `access.profileRef`). |
| `judge.mode` | AIP-45 mode id forwarded to the judge adapter (e.g. `plan`, `bypass-permissions`). |

## `status` vs `wait`

`status` is a **non-blocking snapshot**. It composes over `GET /policies` —
there's no plain `GET /policies/:id` route — deliberately, so a status check
never blocks on a still-running policy.

`wait` **long-polls** `GET /policies/:id/wait` until the policy leaves
`watching`/`gating`/`queued`/`nudging`/`acting`, chaining calls across the
route's ~55s per-call ceiling. `--timeout` defaults to `15m` (`900000ms`); a
gate can be a full test suite or a judge turn, not a quick check.

`wait` exit codes:

| Code | Meaning |
|------|---------|
| `0` | `done` / `awaiting-ack` |
| `2` | `blocked` / `cancelled` / CLI timeout |
| `3` | Not found, or the daemon is too old for the route |

## `ls`

| Flag | Default | Description |
|------|---------|-------------|
| `--session <id>` | — | Only policies watching this session — its single `sessionId`, or any member of a fan-in `sessionIds` group. |
| `--json` | `false` | Emit the `PolicyRunState[]` as JSON. |

The link a policy declares runs policy → session; `--session` reads it back
the other way, answering *what is gating this session?* without eyeballing the
whole list. It narrows server-side (`GET /policies?sessionId=`), the same
filter the `policy_list` MCP tool applies for its own optional `sessionId` —
one definition of "watches this session" across both transports. Nothing is
indexed on disk for it: the filter is a pass over the live list, so there's no
second source of truth to drift.

## `ack`

Resolves a commit parked in awaiting-ack. Exactly one of `--approve` or
`--reject` is required — a host commit has no sensible default, so neither
(or both) exits `2`.

> **Operator gesture.** `ack` is not gated to an operator-only caller in this
> verb, because there is no such check to add: a CLI process holding the
> daemon's bearer token already has full daemon-wide trust, and code here
> cannot tell a human's shell from a delegated agent's. The boundary is the
> same *declared, not enforced* one the root `AGENTS.md` draws for `gh pr
> merge` — a delegated session must not reach for it on its own initiative.

## Examples

```bash
# Gate a session on the test suite; emit on green
agentproto policy attach --session ses_abc12 -- pnpm test

# Same, but block until it settles
agentproto policy attach --session ses_abc12 --wait -- pnpm test

# Green gate → commit, parked for a human ack
agentproto policy attach --session ses_abc12 --then commit \
  --commit-path src --commit-path package.json \
  --commit-message "feat: land the thing" \
  -- pnpm test

# Red gate → nudge and retry, up to 3 times
agentproto policy attach --session ses_abc12 \
  --on-fail-nudge "tests are red — fix them" --on-fail-max-retries 3 \
  -- pnpm test

# Judge gate instead of a shell command
agentproto policy attach --session ses_abc12 \
  --judge-adapter claude-code --judge-prompt "is the diff safe to land?"

# Fan-in: one gate, after every listed session's turn ends
agentproto policy attach --sessions ses_abc12,ses_def34 -- pnpm test

# The full shape, when flags get unwieldy
agentproto policy attach --attach-json @policy.json

# Drive it
agentproto policy ls

# What's gating this session? (matches --session and fan-in --sessions members)
agentproto policy ls --session ses_abc12

agentproto policy status pol_xyz789
agentproto policy wait   pol_xyz789 --timeout 1800000
agentproto policy ack    pol_xyz789 --approve
agentproto policy cancel pol_xyz789
```

## See also

- [`sessions.md`](./sessions.md) — the sessions a policy attaches to
- [`permissions.md`](./permissions.md) — the other human-in-the-loop inbox
- [`serve.md`](./serve.md) — the daemon hosting `/policies`
