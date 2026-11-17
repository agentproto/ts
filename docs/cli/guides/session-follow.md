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
`next-turn` follow, it is delivered as `next-turn`. The always-wake set (a
session awaiting input, a crash, or a turn-end carrying a question) is always
delivered at least at `next-turn`, even on an `fyi` follow. Same-session duplicates in a
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
- every triaged event is appended to the shared delivery ledger
  (`~/.agentproto/delivery-ledger.jsonl`) with `producer: "follow"` - one line
  per digest entry, written after the digest's delivery outcome is known. The
  lines carry the decision's `level`, `rule`, `repeatKey` and `messageId`; see
  `packages/delivery/LEDGER.md` for the schema. `follow-triage.jsonl` is no
  longer written (existing files are left in place for history).

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

## Delivery apply (wake/fyi/drop per event type)

`delivery.apply.types` turns the classifier's decision into the message's
urgency, per event type. It is **shadow by default**: with no key set, every
digest is delivered exactly as before and the ledger records the verdict with
`applied: false`. A type is turned on with a glob key:

```jsonc
{
  "delivery": {
    "apply": {
      "types": {
        "session.*": true,           // every session event: apply its level
        "session.pr_merged": false  // ...except this one
      }
    }
  }
}
```

Keys match the envelope `type` (`session.turn_ended`, `session.awaiting_input`,
`github.check_suite.completed`, ...). A trailing `*` matches a prefix and a bare
`*` matches everything. An exact key beats every glob; otherwise the longest
matching prefix wins. The same switch governs sentinel delivery.

Once a type is applied, its classified level becomes the delivery tier: `3`
and `2` deliver as a wake (`next-turn`), `1` at `fyi`, and `0` is dropped.
Session follows and sentinels have no tier above `next-turn`, so an applied
level `3` is a wake too; what it guarantees is that it is never downgraded to
`fyi` and never dropped. An applied `fyi` never wakes the follower. A level `3`
floor (awaiting-input, crash) is never downgraded. Events whose type is not opted in still deliver as
today (a wake) and keep `applied: false` in the ledger.

There is no second switch: a follow's own `triage.enabled: true` (or the daemon
`follow.triage.enabled: true`) applies every type, and `triage.enabled: false`
applies none, taking precedence over these globs.

A follow's own `triage` block overrides the daemon default, per field: a rule a
follow sets explicitly (`true` or `false`) beats the daemon value, and a rule it
does not name keeps the daemon value. Triage works on the whole digest, so when
several follows feed the same digest: triage runs if ANY of them enables it, and
for a rule they set differently ON wins. A rule value named by ANY follow
feeding the digest counts in that merge (even a follow that did not itself set
`enabled`), so one follow's `false` is overridden by another's `true`. The
`classifier` is never merged from follows: it only comes from the daemon config.

## MCP tools

- `session_follow { follower?, key?, selector, exclude?, events?, batchMs?, skipEmptyTurns?, urgency?, excludeFollowerChildren?, triage? }`
  - `follower` defaults to the calling session; re-using a `key` updates in place.
  - `urgency` is `"next-turn"` (default) or `"fyi"`; existing follows keep `next-turn`.
  - `triage` is the pre-wake classification block (see above).
- `session_unfollow { id }` - follow id (`fol_...`) or key.
- `session_follows { follower? }` - list.

## Desktop host integration

The default follower requires an actual caller identity. Daemon-spawned agents
carry `?callerSessionId=` on their MCP self-mount. The stdio bridge can derive
an external `codex:<thread-id>` caller from the Desktop host's per-call MCP
metadata (see [mcp-bridge](../verbs/mcp-bridge.md#codex-desktop-conversation-identity)).
An unscoped call without that metadata still returns `no_follower`; it must
never choose another session based on recency or the host product name.
Explicit `follower` continues to take precedence.

An external session is inbox-only by default. Registration returns
`delivery.mode: "external-inbox"` and `delivery.wakesFollower: false`. A digest
keeps its original urgency even when no wake transport is configured.

#### Experimental local Codex Desktop wake

On the same machine and OS account as Codex Desktop, add the exact chat UUIDs
you want to wake to the daemon's local `~/.agentproto/config.json` and restart
the daemon. Use `daemon.codexDesktopWakeThreadIds` for an inbox notification
and `daemon.codexDesktopWakeDirectThreadIds` to opt individual chats into
direct message text. The direct list takes precedence for a chat in both lists.

```json
{
  "daemon": {
    "codexDesktopWakeThreadIds": ["00000000-0000-4000-8000-000000000001"],
    "codexDesktopWakeDirectThreadIds": ["00000000-0000-4000-8000-000000000002"]
  }
}
```

The registration response names the `codex-desktop-ipc` transport for those
chats. On a `next-turn` message, the daemon parks the message in the inbox
and asks the loaded local Desktop owner to start a turn with a fixed prompt.
In inbox mode that prompt tells the chat to read its inbox through MCP. In
direct mode, Desktop receives the message IDs, sender metadata and text in
the `untrusted_input` tool output. Use `inbox_list` for the full envelopes,
including any structured data. If the serialized direct payload exceeds
16 KiB in UTF-8, the daemon sends the inbox notification for that batch.

The wake result describes the IPC attempt. Both modes retain the inbox copy
until the chat acknowledges or consumes it through MCP. Messages delivered
directly to an active `inbox_wait` and messages marked `fyi` do not start a
Desktop turn.

The transport uses Desktop's private per-user Unix socket and requires an
owner that advertises support for untrusted app inputs. The direct payload
is visible to the model as tool output and can contain misleading instructions.
Socket checks restrict access by OS user. Processes running as that user can
impersonate Desktop, so direct mode grants that local endpoint access to
the message text.

The daemon batches messages still pending at the time of the IPC write.
Messages arriving after that write get a separate attempt. When Desktop
explicitly refuses a wake because the chat is busy, the daemon retries with
a fresh batch and a backoff from five seconds to one minute. If the outcome
is ambiguous, the daemon leaves that batch in the inbox without resubmitting
it. The inbox survives a normal daemon restart. Wake retries run only while
the daemon is running and the destination remains available.

Desktop updates can change this private protocol. Empty both lists to disable
the transport. The registered capability reflects your configuration. Check
the wake result for the outcome of a specific attempt.

#### Supported host integrations

For durable local Desktop wakes the host needs to implement both halves:

1. Attach the current chat identity to **each** MCP tool request, including
   calls made after a chat switch or reconnect. A shared stdio process's
   environment or MCP handshake is not a per-chat identity source.
2. Own an inbox consumer for each subscribed chat, independently of the
   model's current turn. For example, call `inbox_wait` with `ack: false` and
   the same per-call metadata, renewing its bounded wait. On a `next-turn`
   digest, durably enqueue the digest text in that original chat, then call
   `inbox_ack`. Deduplicate by message id and recover unacked messages after
   reconnect. Busy chats must queue the turn; `fyi` must not start a turn.
   Stop the consumer and remove its follows when the chat is closed.

For a supported integration, the second half belongs in the Desktop host or app. The bridge deliberately does not
spawn `codex --resume` (which creates a separate executor), send messages to
an arbitrary chat, or treat a generic MCP notification as a supported wake.
The [Codex app-server API](https://learn.chatgpt.com/docs/app-server) exposes
thread/turn control to host applications; wiring it into the running
Desktop chat requires that application's support. The documented
[MCP Events integration](https://developers.openai.com/plugins/build/mcp-events)
uses host-provided webhook subscriptions in Work Cloud chats and dots; it is
not an automatic local stdio wake channel.

Regression coverage verifies two concurrent chat identities, a real watched
turn-end reaching each corresponding inbox with `next-turn` urgency, no
identity reuse on an unscoped subsequent call, and explicit-follower
compatibility. Separate Unix-socket regression tests exercise the experimental adapter without submitting turns to the running Desktop app.

## HTTP

```text
POST   /follows            -> 201 (created) | 200 (upserted by key)  body: the follow record
GET    /follows[?follower=<id>] -> 200 { "follows": [...] }
DELETE /follows/:idOrKey   -> 200 { "ok": true, "id": "fol_..." } | 404 { "error": "follow_not_found" }
```

`POST` errors: `400 invalid_input | invalid_selector | no_follower`,
`404 session_not_found` (unknown follower).
