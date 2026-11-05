# Delivery ledger

Every producer appends one line to `~/.agentproto/delivery-ledger.jsonl`
(override the file with the producer's injectable `ledgerPath`). It records
what the delivery kernel decided and what actually happened; it never changes
what is delivered or how. Lines are written **once per (envelope, target),
after the outcome is known** - never a pre-write completed later.

The format is JSON Lines: one UTF-8 JSON object followed by `\n`, mode `0600`.
A failed write is swallowed: recording must never alter delivery.

## Schema

```jsonc
{
  "ts": "2026-11-03T00:00:00.000Z", // ISO time the outcome was known
  "producer": "sentinel",           // "sentinel" | "follow" | "message"
  "subscriptionId": "sen_...",      // who owns the subscription
  "target": { "kind": "session", "id": "sess_..." }, // where it was routed
  "eventId": "evt_...",             // producer-stable event id
  "type": "github.check_suite.completed",
  "subject": "github:acme/widgets#42",
  "eventTs": "2026-11-03T00:00:00.000Z", // optional, producer's event time
  "repeatKey": "github:acme/widgets#42|failure", // optional dedup key
  "floor": "awaiting-human",        // optional; "awaiting-human" | "crash"
  "level": 2,                       // 3 steer, 2 actionable, 1 info, 0 noise
  "cap": 3,                         // highest level this producer may apply
  "rule": "failure",                // classifier / triage rule that decided
  "applied": true,                  // whether the level drove this delivery
  "outcome": "delivered",           // see below
  "routedTo": "sess_...",           // optional; actual target when retargeted
  "messageId": "msg_..."            // optional; the delivered message's id
}
```

There is deliberately no `tier`, `batchId`, `prev`, payload, summary or text
field. The hash chain (`prev`) is the NEXT PR; lines are not linked yet.

`outcome` is one of:

- `delivered`: handed to a live target (via its turn/queue);
- `queued`: accepted for later delivery;
- `inbox`: delivered to a session that was not woken (inbox only);
- `retargeted`: delivered to a different live session (`routedTo`);
- `revived`: delivered after restarting/resuming the target;
- `parked`: written to the parking journal instead of delivered;
- `dropped`: not delivered (triage drop, refusal, or a delivery error);
- `duplicate`: an equivalent watch already covers the subject.

## Producers

- `sentinel`: `subscriptionId` is the sentinel id, `eventId` the event id,
  `repeatKey` its triage key, `level` from the triage decision (`wake` 2,
  `fyi` 1, `drop` 0), `rule` the triage rule, and `messageId` the built
  message id. `applied` is true when `delivery.apply.types` opted the event
  type in: the level then chose the urgency (`targetUrgency`) and a level 0
  is written with outcome `dropped` without sending. Unmatched types deliver
  as before and record `applied: false`. Outcomes cover every path: delivered or
  queued from the send result, `retargeted` when handed to a live parent
  (`routedTo`), `parked` when parked, `duplicate` when another watch already
  covers the subject.
- `follow`: one line per digest entry, so every contributing event is
  represented. `subscriptionId` is the entry's `fol_...` id when it has one,
  else `follower:<followerId>`; `subject` is the followed session id;
  `eventId` is deterministic from the entry: `<sessionId>:<event>:<ts>`;
  `repeatKey` is the entry key; `floor` is `crash` for a crash and
  `awaiting-human` for the other must-wake events; `applied` is per entry -
  true when `delivery.apply.types` (or the follow's/daemon's
  `triage.enabled`) opted that event's type in, else false. Entries not included in the delivered
  digest (triage drop, fyi-only omission) are `dropped` with no `messageId`;
  delivered entries carry the digest message's `messageId`.
- `message`: the parent relay (`subscriptionId: "message:parent-relay"`) and
  `POST /sessions/:id/messages` (`"message:http"`). `type` is
  `message.<kind>` (default `message`), `subject` the sender id, `eventId` and
  `messageId` the envelope id, `level` from urgency (`steer` 3, `next-turn` 2,
  `fyi` 1), `rule: "sender-urgency"`, `applied: false`, outcome `delivered`,
  `queued`, `inbox`, or `dropped` when the send threw.

## Old ledgers

`sentinel-triage.jsonl` and `follow-triage.jsonl` are no longer written (no
dual write). Existing files are left untouched and remain readable for
history.

## COMPAT NOTE: out-of-repo report scripts

Two scripts in `agentik-studio/.plans/2026-10-23-agent-comms-rethink/tools/`
still read the old files and are NOT edited by this change. To move them over,
read both the old files and the new `delivery-ledger.jsonl` across the cutover
and filter the new file by `producer`.

`ledger-report.mjs`

- read `delivery-ledger.jsonl` instead of `follow-triage.jsonl` +
  `sentinel-triage.jsonl`, splitting by `producer`;
- derive `decision` from `level` (`>= 2` wake, `1` fyi, `0` drop);
- follow `event` becomes `type`;
- follow `label` is not recorded: resolve it from `subject` via
  `~/.agentproto/sessions/<id>/index.json`;
- follow `digestId` becomes a group by `messageId`;
- sentinel `target` becomes `target.id`;
- sentinel `urgency` is not recorded: join `messageId` to the delivered
  message in the target's `events.jsonl`;
- keep reading the old files for history (read both across the cutover).

`turns-report.mjs`

- attribute a turn by joining its triggering session-message id to ledger
  lines by `messageId`, instead of parsing the
  `[session-follow] automatic digest` text (around lines 37-56).
