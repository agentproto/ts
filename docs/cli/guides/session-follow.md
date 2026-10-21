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
| `task-changed` | a task on the followed board (`selector.boardId`) changed: created, claimed, a status transition, or a release. A pure field edit is ignored |

`events` defaults to all of them. Empty (silent no-op) turns are dropped unless
`skipEmptyTurns: false`.

## Selector

At least one of `sessionIds` (non-empty), `all: true`, `cwdPrefix`, `boardId` is
required.

- `sessionIds` - explicit ids; always match.
- `all: true` - every session, evaluated at EVENT time, so sessions spawned
  after the follow are covered automatically. `rootOnly` defaults to `true`
  here (sessions with a parent are skipped).
- `cwdPrefix` - sessions whose cwd is that path or below (path-boundary match).
- `boardId` - a task board. Independent of the session selector: `task-changed`
  events are matched on the board id alone (the `sessionIds`/`all`/`cwdPrefix`
  rules do not apply to them). The follower's own writes never wake it (the
  acting session id is compared against the follower).
- `exclude: { sessionIds?, labels? }` - never deliver these.

The follower never receives its own events. By default
(`excludeFollowerChildren: true`) it also never receives events of its own
descendants - it already hears about those through the normal parent/child
channel. With `excludeFollowerChildren: false` its descendants (any depth) are
delivered under a broad selector (`all` or `cwdPrefix`), bypassing `rootOnly`
and `cwdPrefix`, like explicit `sessionIds`.

## Delivery

Events for one follower are coalesced for `batchMs` (default 15000, `0` = next
tick) into ONE `system` / `notice` message. It never interrupts. With the
default `urgency: "next-turn"`, an idle follower runs it as a turn and a busy one
queues it behind the current turn. With `urgency: "fyi"` the digest is parked in
the follower's inbox and never starts a turn, so a supervisor following many
sessions is not woken for every digest. If a batch is fed by both an `fyi` and a
`next-turn` follow, it is delivered as `next-turn`. Same-session duplicates in a
batch collapse (the latest wins). Format:

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

## Triage (pre-wake classification)

An orchestrator that follows many sessions gets woken dozens of times an hour,
and most digests ask for nothing. **Triage** classifies EVERY event `wake` /
`fyi` / `drop` BEFORE a digest is allowed to wake the follower. It is
deterministic (no LLM) and **off by default** - a follow without it behaves
exactly as before.

```jsonc
{
  "selector": { "all": true },
  "triage": {
    "enabled": true,
    "rules": {
      "ownTaskChanges": true,     // your own board writes -> drop
      "operatorExit": true,       // an exit you/the operator asked for -> fyi
      "cronOk": true,             // a cron run that finished OK -> drop
      "reportedTurnEnd": true,    // a turn-end right after the session reported up -> drop
      "emptyTurnEnd": true,       // an empty/cancelled turn-end a new turn superseded -> fyi
      "ownPr": true               // a PR opened by one of your own live sessions -> fyi
    },
    "reportWindowMs": 60000
  }
}
```

Each rule is a separate switch; the rules are checked in a fixed order and the
first match wins. **Always wake**: `awaiting-input`, `crashed`, and a turn-end
that carries a question - no rule (and no classifier) can downgrade those.

What the decision does:

- a digest whose events are all `fyi`/`drop` never wakes: it is parked in the
  follower's inbox as `fyi`;
- one `wake` is enough to wake - and then the digest carries ONLY the `wake`
  events plus a `[session-follow] N other event(s) in info` counter;
- every triaged event is appended to `~/.agentproto/follow-triage.jsonl`
  (`{ ts, follower, event, sessionId, decision, rule }`) - the training data a
  future classifier is fitted on.

The `classifier` block is the documented extension point for a future LLM
classifier (Jev). It lives ONLY in the daemon config (`follow.triage.classifier`
in `~/.agentproto/config.json`) because it runs a shell command or calls a URL on
the daemon host: `session_follow` has no `classifier` field and rejects one. It
receives the event as JSON (on stdin for a `command`, as a
POST body for a `url`) and answers `wake`/`fyi`/`drop`. On timeout, error, or an
unparsable answer the deterministic rules decide instead - a classifier can
refine a decision, never silence the pipeline.

The daemon-wide default lives in `~/.agentproto/config.json`:

```jsonc
{ "follow": { "triage": { "enabled": true, "rules": { "operatorExit": true } } } }
```

A follow's own `triage` block overrides the daemon default, per field: a rule a
follow sets explicitly (`true` or `false`) beats the daemon value, and a rule it
does not name keeps the daemon value. Triage works on the whole digest, so when
several follows feed the same digest: triage runs if ANY of them enables it, and
for a rule they set differently ON wins.

## MCP tools

- `session_follow { follower?, key?, selector, exclude?, events?, batchMs?, skipEmptyTurns?, urgency?, excludeFollowerChildren?, triage? }`
  - `follower` defaults to the calling session; re-using a `key` updates in place.
  - `urgency` is `"next-turn"` (default) or `"fyi"`; existing follows keep `next-turn`.
  - `triage` is the pre-wake classification block (see above).
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
