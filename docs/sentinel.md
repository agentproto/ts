# Sentinel (AIP-60) — primitive & webhook target

> The Sentinel primitive: a persisted watch registry that matches normalized
> events against a spec and delivers them to a target. This doc covers the
> core primitive (spec/match/until/target), the built-in providers, and the
> `webhook` target (Standard Webhooks signed delivery + persisted outbox).

## 1. The primitive

A sentinel is a record in `~/.agentproto/sentinels.json` (AIP-60 §2):

```
SentinelSpec {
  match:   SentinelMatchClause[]   // OR semantics — any clause can match
  until:   SentinelUntil           // when watching stops
  target:  SentinelTarget          // where matching events are delivered
  provider?: string                // resolved slug (local-gh | agentpush | webhook)
  group?: string                   // fan-out grouping (descriptive)
  label?: string                   // human-readable label
}
```

**Match clause**: `{ subject: string, types?: string[] }`. A trailing `*` on
`subject` is a prefix match against an event's `subjects` hierarchy. `types`
are type globs; omitted = the provider's `defaultTypes(subject)`.

**Until**: `{ kind: "subject_terminal" }` | `{ kind: "at", ms }` |
`{ kind: "count", n }` | `{ kind: "never" }`.

**Target**: `{ kind: "session", sessionId, urgency }` |
`{ kind: "routine", routineId }` (frozen, not yet implemented) |
`{ kind: "webhook", url, secret }`.

**Dedup**: `(sentinelId, event.id)` — persisted per sentinel, bounded to the
last 1000 event ids. Survives daemon restart.

## 2. Providers

| Slug | Transport | Notes |
|---|---|---|
| `local-gh` | Poll (~15-60s) | Zero infra; uses host's authenticated `gh` CLI. |
| `agentpush` | Push or poll | Hosted durable subscription; events queue server-side. Needs an agentpush API key. |
| `webhook` | Push | Near-real-time via a GitHub repo hook. Needs a public daemon URL. |

Auto-select order: `agentpush` (when set up) → `webhook` (when a stable
public URL exists and webhook is ready) → `local-gh`.

## 3. Webhook target (Standard Webhooks)

A `webhook` target delivers each matching event as a signed HTTP POST to the
callback URL. The implementation lives in `packages/runtime/src/webhook-egress/`
(signing, SSRF gate, challenge verification, bounded-retry delivery) and
`packages/runtime/src/sentinel-webhook-outbox.ts` (persisted outbox).

### 3.1 Standard Webhooks signature

Each delivery is signed per the [Standard Webhooks](https://www.standardwebhooks.com)
spec:

- **Headers**: `webhook-id`, `webhook-timestamp`, `webhook-signature`
- **Signature format**: `v1,<base64 sigA> v1,<base64 sigB>` (space-separated
  during rotation; single `v1,<base64>` otherwise)
- **HMAC key**: base64-decoded payload after the `whsec_` prefix
- **Signed content**: `msgId.timestamp.body` (HMAC-SHA256)
- **Body**: serialized ONCE per event; the exact bytes are signed and sent.
  Retries re-sign with a fresh timestamp but the SAME body bytes.

### 3.2 Secret at rest

The signing secret never lives inside the `Sentinel` record. At creation,
the raw `secret` is pulled into a sidecar row (`sentinels-secrets.json`,
0600) keyed by an opaque `secretRef`. The stored target shape becomes
`{ kind: "webhook", url, secretRef }`.

`sentinelView()` (the MCP/REST projection) outputs:
```json
{ "kind": "webhook", "url": "https://…", "hasSecret": true, "secretRedacted": true }
```
A raw secret NEVER crosses a listing/get view.

### 3.3 Secret rotation (dual-sign window)

During a rotation window (10 minutes from `rotatedAt`), the store keeps both
`secret` and `prevSecret`. Delivery signs with BOTH secrets so the receiver
can verify either. After the window closes, only the current secret is used.

### 3.4 Challenge verification

Before a subscription is activated, the daemon verifies the callback URL:

1. POST `{"type":"verification","challenge":"<fresh 64-hex>"}` to the callback
2. Headers: `webhook-id: msg_verification_<rand>`, `webhook-timestamp`,
   `webhook-signature` (signed with the candidate secret), `X-MCP-Subscription-Id`
3. Requires 2xx with body `{"challenge":"<same>"}` compared in constant time
4. Result cached per `(principal, normalizedUrl, sha256(secret))` — TTL 10 min
5. A NEW secret during rotation ALWAYS forces re-verification (cache key
   includes the secret hash)

Failure reasons: `challenge_failed`, `timeout`, `non_https`, `ssrf_blocked`,
`non_2xx`.

### 3.5 SSRF protection

All outbound HTTPS to callbacks goes through `ssrfFetch()`:

- HTTPS only (scheme validated)
- DNS resolve → every resolved address (A + AAAA) must pass an
  `isPubliclyRoutable()` predicate (loopback, private, CGNAT, link-local,
  multicast, reserved ranges all blocked)
- Connect to validated IP with original hostname for TLS verify
- No redirect follow (3xx returned as-is)
- Timeout: 10s (challenge), 15s (delivery)

### 3.6 Delivery & retry

`deliverEventEnvelope()` implements bounded-retry delivery:

- **Body clamp**: ≤ 262 144 bytes (256 KiB). If `data` alone exceeds the
  clamp, it is replaced with `{ summary, subject }` and the envelope
  extension `truncated: true` is set.
- **Retry**: exponential backoff, bounded at 5 attempts
- **Per attempt**: fresh timestamp + signature (body bytes unchanged)
- **No retry** on 410 (Gone) or 413 (Payload Too Large) — terminal
- **2xx** = delivered (ack)
- **State**: persisted `DeliveryState { attempts, lastError, lastAt }` so a
  retry can resume post-restart

### 3.7 Persisted outbox

Every matched event for a webhook-target sentinel is appended to a persisted
outbox row BEFORE dispatch:

```
OutboxRow {
  sentinelId, requestId, eventId,
  bodyBytes,          // exact bytes to send (serialized once)
  cursor: null,       // v1: non-replayable
  deliveryState,      // persisted DeliveryState
  status: pending | delivered | dead
}
```

The underlying sentinel event is marked seen/acked ONLY after the outbox row
reaches terminal status. On startup, `resumeWebhookDeliveries()` re-enqueues
every `pending` row by exact bytes (no re-serialization). Outbox rows are
reaped on delivered + 24h.

### 3.8 Expiry

`isExpired(sentinel)` is checked:
- At poll/push ingress
- At delivery dispatch from the outbox
- In a startup + periodic sweep that flips expired rows to `ended:expired`

## 4. MCP surface

| Tool | Description |
|---|---|
| `sentinel_watch` | Create a sentinel (subject/prUrl, types, until, provider, target) |
| `sentinel_list` | List all sentinels (credentials never returned) |
| `sentinel_unwatch` | Stop and remove a sentinel |
| `sentinel_poll_now` | Trigger an immediate poll cycle |
| `list_sentinel_adapters` | Report provider readiness |
| `setup_sentinel_provider` | Configure a provider (e.g. agentpush API key) |

REST twin: `POST /sentinels`, `GET /sentinels`, `GET /sentinels/:id`,
`DELETE /sentinels/:id`.

## 5. CLI

```
agentproto sentinel watch <subject|url> [--types t1,t2] [--session id] [--urgency u]
agentproto sentinel list [--json]
agentproto sentinel rm <id> [--json]
agentproto sentinel status <id> [--json]
```
