# `agentproto sentinel`

Status: Stable

```text
agentproto sentinel watch pr <url> [--session <id>] [--urgency <u>]
                                   [--until closed|never] [--provider <slug>] [--json]
agentproto sentinel watch <subject> [--types <t1,t2,...>] [--session <id>]
                                   [--urgency <u>] [--until closed|never]
                                   [--provider <slug>] [--json]
agentproto sentinel list   [--json]
agentproto sentinel rm     <id> [--json]       (alias: delete, unwatch)
agentproto sentinel status <id> [--json]
```

Manage sentinels - persisted watches that deliver a matching GitHub event
(a check finishing, a review landing, a PR closing) back into a session's
inbox, via the daemon's `/sentinels` HTTP routes. Same daemon-discovery
pattern as [`tunnel.md`](./tunnel.md) and [`sessions.md`](./sessions.md):
env override, then `~/.agentproto/runtime.json` (pid-checked), then the
central registry, then each configured workspace's own `runtime.json`.

Requires a running daemon ([`serve.md`](./serve.md) or
[`daemon.md`](./daemon.md)).

For the end-to-end "wake an agent when CI or a review lands" workflow, see
the [sentinels guide](../guides/sentinels.md).

## `--session` is required

`--session` has no default from the CLI - a CLI invocation has no calling
session identity to default to (unlike the MCP `sentinel_watch` tool, which
defaults to the calling session). `agentproto sentinel watch ...` without
`--session` fails with `no_caller_identity`.

## `watch pr <url>`

Sugar for the common case: parses a `github.com` PR URL into subject
`github:owner/repo#N`, the default PR type set (`github.check_suite.completed`,
`github.workflow_run.completed`, `github.pull_request_review.submitted`,
`github.pull_request.closed`, `github.pull_request.synchronize`,
`github.issue_comment.created`), and `--until closed` (`subject_terminal` -
the sentinel expires once the PR closes or merges).

| Flag | Default | Description |
|------|---------|-------------|
| `--session <id>` | *(required)* | Target session to deliver matching events to. |
| `--urgency <u>` | `next-turn` | Inbox delivery urgency: `fyi` \| `next-turn` \| `steer` \| `interrupt`. |
| `--until <kind>` | `closed` | `closed` (alias for `subject_terminal`) \| `never`. |
| `--provider <slug>` | auto-selected | `local-gh` \| `webhook`. See [Providers](#providers). |
| `--json` | `false` | Emit the created sentinel as JSON. |

## `watch <subject>`

Watches a raw subject directly - a PR (`github:owner/repo#N`), an entire
repo (`github:owner/repo`) or owner (`github:owner`) via a trailing `*`
prefix match, or ANOTHER SESSION's own lifecycle (`session:<id>`) - woken on
its turn-end, awaiting-input or exit, even if it never calls
`message_parent`, self-expiring once it exits. For a `session:<id>`
subject, `--until` defaults to `closed` (not `never`) and `--provider`
defaults to `session`, same as the PR sugar form.

| Flag | Default | Description |
|------|---------|-------------|
| `--types <t1,t2,...>` | the provider's `defaultTypes(subject)` | Comma-separated type globs to match. |
| `--session <id>` | *(required)* | Target session to deliver matching events to - distinct from the `<id>` inside a `session:<id>` subject (the session being WATCHED). |
| `--urgency <u>` | `next-turn` | Inbox delivery urgency: `fyi` \| `next-turn` \| `steer` \| `interrupt`. |
| `--until <kind>` | `never` (`closed` for a `session:<id>` subject) | `closed` (alias for `subject_terminal`) \| `never`. |
| `--provider <slug>` | auto-selected | `local-gh` \| `webhook` \| `session`. See [Providers](#providers). |
| `--json` | `false` | Emit the created sentinel as JSON. |

Prefer `session:<id>` over the `session_follow` MCP tool for a single known
target that should auto-expire on exit; prefer a follow for a broad
selector (`all`/`cwdPrefix`) with coalesced digests across many sessions.

## `list`

Lists every sentinel known to the daemon via `GET /sentinels`. Credentials
are never returned.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit an array of sentinel descriptors. |

## `rm <id>`

Stops and removes a sentinel via `DELETE /sentinels/:id`. Accepts `delete`
and `unwatch` as aliases.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit `{"ok":bool,"id":str}` as JSON. |

## `status <id>`

Prints a detailed descriptor for one sentinel via `GET /sentinels/:id`.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit the full descriptor as JSON. |

## Providers

| Slug | Transport | Notes |
|------|-----------|-------|
| `local-gh` | Poll (~15-60s) | Zero infra - uses the host's authenticated `gh` CLI. Does not watch comments (`github.issue_comment.created`); add `webhook` or `agentpush` for that. |
| `webhook` (Experimental) | Push | Near-real-time via a GitHub repo hook. Needs a public daemon URL (a named tunnel or `AGENTPROTO_PUBLIC_URL`) and a `gh` token with `admin:repo_hook`. |
| `agentpush` (Experimental) | Push or poll | Hosted durable subscription; events queue server-side even while the daemon is down. Needs an agentpush workspace API key. Not selectable from this CLI's `--provider` flag directly - set up via `setup_sentinel_provider` and it is then picked automatically when ready. |
| `session` | Poll (~15-60s, in-process) | Zero infra, no credentials - watches another AGENTPROTO SESSION's own lifecycle (not GitHub). Only understands a `session:<id>` subject, and is always picked for one regardless of the other providers' readiness. Non-durable: a daemon restart loses any buffered-but-undelivered events. |

`--provider` omitted for a GitHub subject: the daemon auto-selects
`agentpush` when set up, else `webhook` when a stable public URL exists and
the provider is ready, else `local-gh`. For a `session:<id>` subject it
always picks `session`. Check readiness with the `list_sentinel_adapters`
MCP tool.

## Auto-watch on PR open

The daemon can create a sentinel automatically when an agent session opens
a PR (`gh pr create` run via `command_execute`, or discovered by the PR
provenance reconciler) - no `sentinel watch` call needed. This is
`config.sentinel.autoWatchPrs` (defaults to `true` only when `local-gh` is
usable), with a per-spawn opt-out (`agent_start`'s `sentinel: false`). See
the [sentinels guide](../guides/sentinels.md) for the full flow.

## Sentinel model, MCP surface and webhook target

A sentinel is a record in `~/.agentproto/sentinels.json` with a `match` (OR
over `{ subject, types }` clauses), an `until` (`subject_terminal`, `at`,
`count` or `never`), and a `target` (`session`, or the Experimental `webhook`
target). Events are deduplicated per sentinel on the last 1000 event ids.

The same operations are exposed to agents as the MCP tools `sentinel_watch`,
`sentinel_list`, `sentinel_unwatch`, `sentinel_poll_now`,
`list_sentinel_adapters` and `setup_sentinel_provider`, and over REST as
`POST /sentinels`, `GET /sentinels`, `GET /sentinels/:id` and
`DELETE /sentinels/:id`.

The signed-delivery `webhook` target (Standard Webhooks signature, secret
rotation, callback verification, SSRF rules, retry schedule, persisted outbox)
is documented in the
[Sentinel webhook target reference](../reference/sentinel-webhook.md)
(Experimental).

## Examples

```bash
# Watch a PR this session just opened
agentproto sentinel watch pr https://github.com/agentproto/ts/pull/1501 --session sess_abc123

# Same, but force the webhook provider
agentproto sentinel watch pr https://github.com/agentproto/ts/pull/1501 --session sess_abc123 --provider webhook

# Watch an entire repo for issue comments, never expiring
agentproto sentinel watch github:agentproto/ts --types 'github.issue_comment.*' --session sess_abc123

# Watch a child session's lifecycle - woken on turn-end/awaiting-input/exit,
# self-expiring once it exits
agentproto sentinel watch session:sess_child456 --session sess_supervisor789

# List, inspect, stop
agentproto sentinel list
agentproto sentinel status sen_01ABC...
agentproto sentinel rm sen_01ABC...
```

## See also

- [sentinels guide](../guides/sentinels.md) - end-to-end: wake an agent when CI or a review lands on its PR
- [Sentinel webhook target reference](../reference/sentinel-webhook.md) - signed delivery, outbox, SSRF, retries (Experimental)
- [`serve.md`](./serve.md) - daemon that hosts sentinels
- [`tunnel.md`](./tunnel.md) - public tunnels, needed for the `webhook` provider
