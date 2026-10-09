# Sentinel webhook target reference

Status: Experimental

How a sentinel with a `webhook` **target** delivers matching events as signed
HTTP POSTs: the signature scheme, secret handling, callback verification, SSRF
rules, retry schedule, the persisted outbox, and expiry. Companion to the
[`sentinel` verb page](../verbs/sentinel.md) and the
[sentinels guide](../guides/sentinels.md).

A webhook *target* (where events go) is not the `webhook` *provider* (how
events are collected from GitHub). The CLI's `sentinel watch` and the
`sentinel_watch` MCP tool create `session` targets only; a `webhook` target is
created through the daemon's sentinel store, and `sentinel list` / `status`
show it with the secret redacted.

Implementation: `packages/runtime/src/webhook-egress/` (signing, SSRF gate,
challenge verification, bounded-retry delivery) and
`packages/runtime/src/sentinel-webhook-outbox.ts` (persisted outbox).

## Sentinel model

A sentinel is a record in `~/.agentproto/sentinels.json` (the AIP-60 sentinel
spec, see the [AgentProto docs](https://agentproto.sh/docs)):

```text
SentinelSpec {
  match:     SentinelMatchClause[]   // OR semantics: any clause can match
  until:     SentinelUntil           // when watching stops
  target:    SentinelTarget          // where matching events are delivered
  provider?: string                  // resolved slug (local-gh | agentpush | webhook)
  group?:    string                  // fan-out grouping (descriptive)
  label?:    string                  // human-readable label
}
```

- **Match clause**: `{ subject: string, types?: string[] }`. A trailing `*` on
  `subject` is a prefix match against an event's `subjects` hierarchy.
  `types` are type globs; omitted means the provider's `defaultTypes(subject)`.
- **Until**: `{ kind: "subject_terminal" }` | `{ kind: "at", ms }` |
  `{ kind: "count", n }` | `{ kind: "never" }`.
- **Target**: `{ kind: "session", sessionId, urgency }` |
  `{ kind: "routine", routineId }` (shape frozen, not implemented: creating one
  is refused with `not_implemented`) | `{ kind: "webhook", url, secret }`.
- **Dedup**: keyed by `(sentinelId, event.id)`, persisted per sentinel and
  bounded to the last 1000 event ids. Survives a daemon restart.

## Standard Webhooks signature

Each delivery is signed per the
[Standard Webhooks](https://www.standardwebhooks.com) spec.

- **Headers**: `webhook-id` (the stable event id, identical across retries),
  `webhook-timestamp` (Unix seconds), `webhook-signature`, plus
  `content-type: application/json`.
- **Signature format**: `v1,<base64 sigA> v1,<base64 sigB>`, space-separated
  while a rotation window is open; a single `v1,<base64>` otherwise.
- **Secret format**: `whsec_` followed by base64 that decodes to 24 to 64 bytes.
  A malformed secret is rejected, never signed with.
- **HMAC key**: the base64-decoded payload after the `whsec_` prefix.
- **Signed content**: `msgId.timestamp.body`, HMAC-SHA256, where `msgId` is the
  `webhook-id` value.
- **Body**: serialized once per event; the exact bytes are signed and sent.
  Retries re-sign with a fresh timestamp but send the same body bytes.

## Secret at rest

The signing secret never lives inside the `Sentinel` record. At creation the
raw `secret` is moved into a sidecar file, `sentinels-secrets.json` (mode
`0600`, next to `sentinels.json`), keyed by an opaque `swsec_<ulid>`
`secretRef`. The stored target becomes `{ kind: "webhook", url, secretRef }`.

The projection returned by `sentinel list`, `sentinel status`, the
`sentinel_list` MCP tool and the `/sentinels` REST routes is:

```json
{ "kind": "webhook", "url": "https://...", "hasSecret": true, "secretRedacted": true }
```

A raw secret never crosses a listing or get view. Removing the sentinel removes
its sidecar row.

## Secret rotation (dual-sign window)

When a sentinel's secret changes, the store keeps the old one as `prevSecret`
and records `rotatedAt`. For 10 minutes from `rotatedAt`, delivery signs with
both secrets (two `v1,` segments in `webhook-signature`), so a receiver can
verify with either. After the window closes only the current secret signs.

## Challenge verification

Before a subscription is activated, the daemon verifies the callback URL:

1. POST `{"type":"verification","challenge":"<fresh 64-hex>"}` to the callback.
2. Headers: `webhook-id: msg_verification_<random>`, `webhook-timestamp`,
   `webhook-signature` (signed with the candidate secret), and
   `X-MCP-Subscription-Id`.
3. The callback must answer 2xx with a JSON body `{"challenge":"<same value>"}`.
   The comparison is constant-time.
4. A successful result is cached per `(principal, normalizedUrl,
   sha256(secret))` for 10 minutes. The URL is normalized (lowercase scheme and
   host, default port 443 dropped).
5. A new secret during rotation always forces re-verification, because the
   cache key includes the secret hash.

Failure reasons: `challenge_failed` (bad secret format, non-JSON response, or
the challenge was not echoed), `timeout` (also covers connect failures),
`non_https`, `ssrf_blocked` (private target or a redirect), `non_2xx`.

## SSRF protection

All outbound HTTPS to callbacks goes through `ssrfFetch()`:

- HTTPS only; the scheme is validated.
- DNS resolution: every resolved address (A and AAAA) must pass
  `isPubliclyRoutable()`. Loopback, private, CGNAT, link-local, multicast and
  reserved ranges are all blocked.
- The connection goes to the validated IP, while the original hostname is kept
  for TLS verification and the HTTP `Host` header.
- Redirects are never followed; a 3xx is returned as-is (a redirect to a
  non-https target additionally fails as `redirect`).
- Timeouts: 10 s for a challenge, 15 s for a delivery.
- The request body is clamped to 256 KiB here too.

Failure reasons from the gate: `non_https`, `private_target`, `redirect`,
`timeout`, `connect`.

## Delivery and retry

`deliverEventEnvelope()` implements bounded-retry delivery:

- **Body clamp**: at most 262 144 bytes (256 KiB). If the serialized body
  exceeds that, `data` is replaced with `{ summary, subject }` and the envelope
  gains `truncated: true`.
- **Attempts**: at most 5. The wait before attempts 2 to 5 is 500 ms, 1 s, 2 s,
  then 4 s (exponential from 250 ms, capped at 4 s).
- **Per attempt**: a fresh timestamp and signature; the body bytes are
  unchanged.
- **Success**: any 2xx is an ack.
- **Retried**: 3xx, other 4xx, 5xx, and network errors.
- **Terminal, no retry**: 410 (Gone) and 413 (Payload Too Large), and a secret
  that fails to decode.
- **State**: a `DeliveryState { attempts, lastError, lastAt }` is persisted with
  the outbox row, so a retry can resume after a restart.

## Persisted outbox

Every matched event for a webhook-target sentinel is appended to a persisted
outbox row before dispatch. The file is `~/.agentproto/sentinel-webhook-outbox.json`.

```text
OutboxRow {
  sentinelId, requestId, eventId,
  bodyBytes,       // exact bytes to send (serialized once)
  cursor: null,    // v1: non-replayable
  deliveryState,   // persisted DeliveryState
  status: pending | delivered | dead
}
```

- A row is unique per `(sentinelId, eventId)`; a duplicate event never creates a
  second row.
- The underlying sentinel event is marked seen only after the row reaches a
  terminal status (`delivered` or `dead`). A dispatch that crashes mid-flight
  leaves the row `pending` and the event un-acked.
- On startup, `resumeWebhookDeliveries()` re-enqueues every `pending` row by its
  exact stored bytes, with no re-serialization.
- A row goes `dead` when retries are exhausted or terminally rejected
  (`delivered_rejected`), when its sentinel expired (`sentinel_expired`), or
  when the sentinel or its secret was removed (`sentinel_removed`).
- Reaping: `delivered` rows are removed 24 hours after delivery; `pending` rows
  older than 7 days age out to `dead`; the file is capped at 2000 rows.
- Ordering across events is not guaranteed.

## Delivery observability

Each delivery attempt writes one log line: sentinel id, event, the callback
**host** only, the HTTP status or a redacted error, the attempt number, and a
final `delivered` / `dead`. URL paths, tokens, bodies and secrets are never
logged.

`sentinel_list` and `GET /sentinels` also add a `deliveryStatus` object to
each sentinel that has outbox rows (it is omitted when the outbox holds none
for that sentinel). `GET /sentinels/:id` does not carry it.

```json
{ "active": false, "lastDeliveryAt": "2026-10-09T10:00:00.000Z",
  "lastStatus": "dead", "lastError": "delivered_rejected", "attempts": 5, "dead": 1 }
```

- `active`: at least one row is still `pending`.
- `lastDeliveryAt`: time of the most recent attempt, when one ran.
- `lastStatus`: `pending`, `delivered` or `dead`, for the most recent row.
- `lastError`: present unless the last row was `delivered`; URLs are redacted.
- `attempts`: attempts spent on the most recent row.
- `dead`: number of `dead` rows the outbox still holds.

The `events/subscribe` result is unchanged.

## Expiry

`isExpired(sentinel)` is checked:

- at poll and push ingress,
- at delivery dispatch from the outbox (an expired sentinel's row goes `dead`
  without sending),
- in a sweep at startup and on the periodic tick, which flips expired sentinels
  to `status: expired` (shown as `ended:expired` in the logs) and cancels their
  provider-side watch.

## MCP and REST surface

| Tool | Description |
|------|-------------|
| `sentinel_watch` | Create a sentinel (subject or `prUrl`, types, until, provider, session target). |
| `sentinel_list` | List all sentinels (credentials never returned; webhook targets add `deliveryStatus`). |
| `sentinel_unwatch` | Stop and remove a sentinel. |
| `sentinel_poll_now` | Trigger an immediate poll cycle. |
| `list_sentinel_adapters` | Report provider readiness. |
| `setup_sentinel_provider` | Configure a provider (for example the agentpush API key). |

REST twin: `POST /sentinels`, `GET /sentinels`, `GET /sentinels/:id`,
`DELETE /sentinels/:id`.

## See also

- [`sentinel` verb page](../verbs/sentinel.md): CLI flags and providers
- [sentinels guide](../guides/sentinels.md): end-to-end workflow
