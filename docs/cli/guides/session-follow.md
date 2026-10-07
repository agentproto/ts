# Wake a session when other sessions finish, wait, crash, or open a PR

Status: Experimental

A long-lived "chief" session (a supervisor, a chat bridge, an on-call agent)
often needs to know what the OTHER sessions on the daemon are doing - including
root sessions it did not spawn. Polling `session_list` burns turns. A **session
follow** subscribes a session (the *follower*) to the lifecycle events of
sessions matched by a selector; the daemon wakes the follower with one
coalesced digest.

Sentinels watch external subjects (a PR, CI). Follows watch other *sessions*.

## Events

| Event | Fires when |
|-------|-----------|
| `turn-end` | a followed session ends a turn |
| `awaiting-input` | a followed session stopped and is waiting for an answer (a turn-end that left it awaiting input is reported once, as this) |
| `exited` | a followed session ended (any status except a crash) |
| `crashed` | a followed session ended with status `error` or reason `crashed` |
| `pr-opened` | a followed session got a new PR activity |
| `pr-merged` | a followed session's PR activity reached `done` (closed-unmerged / cancelled is ignored) |

`events` defaults to all of them. Empty (silent no-op) turns are dropped unless
`skipEmptyTurns: false`.

## Selector

At least one of `sessionIds` (non-empty), `all: true`, `cwdPrefix` is required.

- `sessionIds` - explicit ids; always match.
- `all: true` - every session, evaluated at EVENT time, so sessions spawned
  after the follow are covered automatically. `rootOnly` defaults to `true`
  here (sessions with a parent are skipped).
- `cwdPrefix` - sessions whose cwd is that path or below (path-boundary match).
- `exclude: { sessionIds?, labels? }` - never deliver these.

The follower never receives its own events. By default
(`excludeFollowerChildren: true`) it also never receives events of its own
descendants - it already hears about those through the normal parent/child
channel. With `excludeFollowerChildren: false` its descendants (any depth) are
delivered under a broad selector (`all` or `cwdPrefix`), bypassing `rootOnly`
and `cwdPrefix`, like explicit `sessionIds`.

## Delivery

Events for one follower are coalesced for `batchMs` (default 15000, `0` = next
tick) into ONE `system` / `notice` / `next-turn` message. It never interrupts:
an idle follower runs it as a turn, a busy one queues it behind the current
turn. Same-session duplicates in a batch collapse (the latest wins). Format:

```text
[session-follow] automatic digest — 2 events from sessions you follow. Decide whether anything needs the human's attention; if not, no reply is needed.
[session-follow] <label|id> (<id>) <event> — <cwd basename> — <excerpt, <=300 chars>
```

The excerpt is the tail of the session's last output (or its outcome summary /
error / exit reason), prefixed with `…` when trimmed. More than 40 events add a
final `[session-follow] … and N more event(s)` line.

A follower that is gone is not an error: the follow is kept. A dead follower is
resumed like a sentinel target is (never if it was deliberately closed); when it
cannot be, the digest is appended to `~/.agentproto/follows-parked.jsonl`.

Follows persist in `~/.agentproto/follows.json` (next to `sentinels.json`).

## MCP tools

- `session_follow { follower?, key?, selector, exclude?, events?, batchMs?, skipEmptyTurns?, excludeFollowerChildren? }`
  - `follower` defaults to the calling session; re-using a `key` updates in place.
- `session_unfollow { id }` - follow id (`fol_...`) or key.
- `session_follows { follower? }` - list.

## HTTP

```text
POST   /follows            -> 201 (created) | 200 (upserted by key)  body: the follow record
GET    /follows[?follower=<id>] -> 200 { "follows": [...] }
DELETE /follows/:idOrKey   -> 200 { "ok": true, "id": "fol_..." } | 404 { "error": "follow_not_found" }
```

`POST` errors: `400 invalid_input | invalid_selector | no_follower`,
`404 session_not_found` (unknown follower).
