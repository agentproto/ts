# MCP Events integration

> The agentproto daemon is OpenAI MCP Events compatible: native JSON-RPC
> methods `events/list`, `events/subscribe`, `events/unsubscribe` on the
> authenticated `/mcp` endpoint, plus an `events:{}` capability at
> `initialize` (`server/discover` is not served until the 2026-07-28 era is).
> This doc is the single mapping authority — the Contract Map below is
> reprinted verbatim from the plan and is the source of truth for both the
> AIP-60 doc update and the test matrix.

## 1. Architecture

Sentinel stays the core primitive (match/until/target, CloudEvents envelope).
MCP Events is a **client profile** served over it. ChatGPT is one subscriber
among others (session inbox, future routine), not a fork in the architecture.

Event wire format: payload `data` stays CloudEvents 1.0 **inside** the MCP
Events envelope. The envelope fields are `eventId`, `name`, `data`,
`timestamp`, `cursor`.

## 2. Contract Map — spec ⇄ implementation (single source of truth)

| MCP Events concept (OpenAI doc) | Contract in our system | Lives in | Test names (grep-able) |
|---|---|---|---|
| `events:{}` capability advertised at `initialize` (`server/discover` unregistered — FIX-10 / #1508) | the TRANSPORT's capabilities object, not the adapter | `packages/mcp-server` (request handling) | `discover-exposes-events-capability` |
| `events/list` — stable `name`, specific `description`, `inputSchema` (filters), `payloadSchema` | EventDefinition, declared **per provider scheme** from `defaultTypes()` + a hand-written payload map per scheme (W-B1) | `mcp-events/events-registry.ts` | `events-list-tenant-scoped`, `events-list-pagination` |
| server-side filter application | `SentinelSpec.match` clauses (subject prefix + type globs) | `sentinel-store.ts` (exists) | existing store tests + `filters-applied-server-side` |
| only tenant-visible events | registry filters definitions by principal's reachable schemes | `events-registry.ts` | merged into `events-list-tenant-scoped` |
| `nextCursor` pagination | `cursor` query param on `events/list`, opaque token = offset+scheme checkpoint | `events-registry.ts` | merged into `events-list-pagination` |
| deterministic subscription id (principal + callback URL + event name + args, canonical JSON) | `subscriptionId(subInput)` — sha256 over **RFC 8785 (JCS) canonical JSON** (full spec: recursive key sort, Unicode minimization, ECMAScript number serialization; args payload is trustless input, nested objects legal); same identity = **upsert**, never duplicate | `mcp-events/subscription-id.ts` | `sub-id-canonical-jcs`, `sub-id-no-duplicate` |
| callback verification (challenge POST, signed, one-shot, short TTL) | `verifyCallback()` — 2xx required, constant-time compare, keyed cache per **(principal + normalized callback URL + sha256(secret)) — a NEW secret during rotation ALWAYS forces re-verification (the cache can never bless an unverified secret)**, bounded TTL 10 min | `webhook-egress/challenge.ts` | `challenge-success`, `challenge-fail-reason-categorized`, `challenge-cache-hit`, `challenge-new-secret-bypasses-cache` |
| `CallbackEndpointError -32015` + `data.reason` | JSON-RPC error on subscribe; `reason ∈ {challenge_failed, timeout, non_https, ssrf_blocked, non_2xx}` | `webhook-egress/challenge.ts` | merged into `challenge-fail-reason-categorized` |
| SSRF (HTTPS only, validated addr connect w/ hostname verified, no private, no redirect) | `ssrfFetch()` under challenge AND delivery (I3) | `webhook-egress/ssrf-fetch.ts` | `ssrf-blocks-private`, `ssrf-no-redirect`, `ssrf-same-fn-both-paths` |
| event envelope `eventId/name/data/timestamp/cursor` | CloudEvents `SentinelEvent` mapped: `id→eventId` (and into the `webhook-id` header), `type→name`, `data→data`, `time→timestamp`, plus top-level `cursor` per §3; top-level `type` = protocol control notifications only, never sent | `mcp-events/adapter.ts` (`toMcpEvent`) | `envelope-mapping` |
| body serialized once + signed bytes (I2) | `signWebhook()` returns **ONLY headers**; the caller owns the bytes and `deliverEventEnvelope` PASSes/returns those same bytes so retry re-signs without re-serializing | `webhook-egress/{signing,delivery}.ts` | `sign-body-once`, `retry-keeps-bytes` |
| Standard Webhooks signature `webhook-id|timestamp|body`, dual-sign rotation | `signWebhook({..secrets[]})` — **standard base64** (not base64url) `v1,<b64>` segments; HMAC key = base64 payload DECODED after `whsec_` prefix; space-separated signatures | same | `dual-sign-during-rotation` |
| ≤ 256 KiB, one event per request | clamp/oversize → replace `data` with `{summary, subject}` + envelope extension `truncated: true` (NO read tool — see §5) | `webhook-egress/delivery.ts` | `payload-clamp-256kib` |
| ack semantics (2xx = delivered) | delivery result gate | same | `delivery-2xx-ack` |
| retries: exponential bounded, new timestamp+sig per attempt, no-retry on 410/413 | `deliverEventEnvelope(sub, event)` loop | same | `retry-backoff-bounded`, `retry-new-signature`, `no-retry-410-413` |
| secret rotation during refresh (dual-sign window) | subscribe-refresh writes new secret, delivery consults both secrets while window open | `webhook-egress/signing.ts` + `mcp-events/adapter.ts` | `rotation-window-both-secrets` |
| TTL: `ttlMs` omitted → default 7d; `number` → grant `min(requested, 30d)` but never below 60s floor; `null` → `until:{kind:"never"}` → `refreshBefore: null` | `until: {kind:"at", ms}` in store; **`refreshBefore` = the GRANTED EXPIRATION itself (`until.ms` as ISO-8601), per the official doc — never a pre-expiry hint**; one function `computeRefreshBefore()` in §3, claused nowhere else | `mcp-events/adapter.ts` | `ttl-clamp`, `refresh-before-expires` |
| `ttlMs: null` | unexpire sentinel (`until:{kind:"never"}`) returns `refreshBefore: null` | same | `ttl-null-no-refresh-needed` |
| client refresh before expiry (same sub identity + last cursor) | upsert path reuses existing sub id; returns new `refreshBefore` = new `until.ms`; cursor is accepted but NOT replayed (v1 non-replayable — `cursor:null` back) | `mcp-events/adapter.ts` | merged into `refresh-before-expires` |
| replay via `cursor`; `truncated` when history gone; un-replayable types → `cursor: null` | **v1 REALITY (verified in code): NO provider has historical replay** — `local-gh` polls by snapshot diffing, providers' `poll(handle, limit)` accepts a `SentinelHandle`, not a `(cursor, limit)` pair, and there is no `{truncated}` path. So v1 declares EVERY event definition non-replayable: subscribe/refresh always return `cursor: null`, `truncated: false` never set. Replayable cursor mechanics = explicit follow-up (a replay `ArgumentError`-free provider API + cursor validation) — DO NOT fake it on top of snapshot diffing (it would invent phantom cursors). | `mcp-events/adapter.ts` | `unreplayable-cursor-null` (replay suites are explicitly OUT of v1) |
| `events/unsubscribe` with same event name + args + URL; idempotent | remove-by-deterministic-id path; second call returns `{}` | `mcp-events/adapter.ts` | `unsubscribe-idempotent` |
| delivery ordering non-guaranteed; consumer idempotence | I1 dedup + docs note (W-D) | docs | — |
| bursts / batching, `read` retrieval of full record | **explicitly cut** (see §5) — ChatGPT treats 2xx accept async; we only promise body shape | — | — |

Anything new anyone builds downstream MUST add a row to this table + a test row.

## 3. Explicitly NOT supported (v1)

The following are **explicitly cut** from v1. Do not attempt to use them;
they will not work and are not planned for this release.

| Cut | Why |
|---|---|
| **Polling** transport | MCP Events is push-only; we deliver via webhook POST. |
| **Streaming** transport | Same — no SSE/streaming channel exists. |
| **Control notifications** (`gap`, `terminated`) | ChatGPT doesn't support them either; we send no control events. |
| **Event batching** across subscribers | One event per POST. The client may group server-side. |
| **ChatGPT plugin manifest** | Their side handles discovery; we only need the capability flag + methods. |
| **`read` tool** for oversized payloads | The 256 KiB clamp reduces `data` to `{summary, subject}`. A full-read tool is a follow-up (W-F) only if real usage demands it. |
| **Replay via cursor** | No provider has historical replay. All event definitions are non-replayable in v1: `cursor: null` always, `truncated` never set. |
| **`sentinel` routine target** | Reserved for AIP-41 `schedule.kind: event` binding; not yet implemented. |
| **Per-principal multi-tenant identity** | v1 principal is `"daemon-bearer"` or `session:<sessionId>`. Auth-profile plumbing is W-F. |

## 4. Delivery / retry / sizing facts

| Fact | Value |
|---|---|
| Body clamp | ≤ 262 144 bytes (256 KiB); oversize `data` → `{summary, subject}` + `truncated: true` |
| Retry backoff | Exponential, bounded at **5 attempts** |
| Per-attempt signing | Fresh timestamp + signature; body bytes unchanged (serialized once) |
| No-retry statuses | **410** (Gone), **413** (Payload Too Large) — terminal |
| Dual-sign window | **10 minutes** from `rotatedAt`; both secrets signed |
| Challenge cache TTL | **10 minutes**; key = `(principal, normalizedUrl, sha256(secret))` |
| `refreshBefore` | = `until.ms` (granted expiration as ISO-8601), never a pre-expiry hint |
| TTL default | 7 days (when `ttlMs` omitted) |
| TTL cap | `min(requested, 30 days)`, never below 60s floor |
| `ttlMs: null` | `until:{kind:"never"}` → `refreshBefore: null` |
| Dedup key | `(sentinelId, event.id)` — stable across retries |
| Ordering | **Not guaranteed** between two events of the same subscription (I5) |
| Consumer requirement | Must be idempotent — redelivery is a no-op for dedup-aware consumers |
| Outbox reap | Delivered rows reaped after 24h |
| SSRF timeout | 10s (challenge), 15s (delivery) |

## 5. Error mapping

### Challenge failure → JSON-RPC

| `ChallengeFailureReason` | JSON-RPC `data.reason` |
|---|---|
| `challenge_failed` | `challenge_failed` |
| `timeout` | `timeout` |
| `non_https` | `non_https` |
| `ssrf_blocked` | `ssrf_blocked` |
| `non_2xx` | `non_2xx` |

### JSON-RPC error codes

| Code | Meaning |
|---|---|
| `-32602` | Invalid params (unknown event, bad args vs `inputSchema`) |
| `-32015` | `CallbackEndpointError` — challenge verification failed |
| `-32016` | `BackingSubscriptionError` — a refresh could not renew the backing remote subscription. `data.reason`: `backing_subscription_expired` (remote already expired/deleted: unsubscribe and subscribe again; local state is untouched and no second remote is provisioned) or `backing_renew_failed` (transient: retry the refresh) |

## 6. Security invariants

- **I1** — event `id` is stable across retries; dedup stays `(sentinelId, event.id)`.
- **I2** — the delivery body is serialized once and those exact bytes are signed and sent.
- **I3** — outbound HTTPS to callbacks is never issued through `egress`; new module only, validated-IP connect + original-hostname TLS verify, private ranges blocked. Applies to challenge AND delivery identically.
- **I4** — subscription rows survive daemon restart (store life is persistent; `attach()` path exercised).
- **I5** — ordering is never assumed between two events of the same subscription; consumers must be idempotent.
- **I6** — no prompt-injection surface: `data` is data; the dagger applied to inbox text (`summary` prefixing via "sentinel") is the only place model-directed text is synthesized.

## 7. Serving ChatGPT (2026-07-28 events origin)

The daemon can expose a second, public MCP origin that speaks only the stateless 2026-07-28 protocol and only the
events surface, for clients such as ChatGPT that cannot reach the operator's authenticated `/mcp`. It is off unless
configured. Whether ChatGPT accepts this origin end to end is **not yet proven**: validation against ChatGPT is pending
(P2/P3 of the 2026-07-28 plan).

### Configuration

| Env var | Meaning |
|---|---|
| `AGENTPROTO_MCP_EVENTS_SECRET` | Path secret. At least 32 characters or the route is not mounted. |
| `AGENTPROTO_MCP_EVENTS_REPOS` | Comma-separated `owner/repo` allowlist. A subscribe whose `arguments.repo` is not listed is refused (`-32602`); empty = every subscribe is refused. |
| `AGENTPROTO_MCP_EVENTS_ORIGINS` | Comma-separated browser `Origin` values to accept. Default none: any request carrying an `Origin` header is a 403. A request with no `Origin` is allowed. |

URL shape: `https://<host>/mcp/events/<secret>`. A wrong, missing or malformed secret segment answers `404`
`{"error":"not_found"}` with `cache-control: no-store`.

### Surface

Exactly `server/discover`, the `events/*` methods (`events/list`, `events/subscribe`, `events/unsubscribe`) and one
probe tool, `events_ping`. No other tools, resources or prompts are reachable here; the server is built from scratch for
this origin (`packages/runtime/src/mcp-events-surface.ts`). Each request is served by a fresh in-process server
(stateless, no `Mcp-Session-Id`).

### Isolation

- **Repo allowlist.** Subscriptions are limited to the repos in `AGENTPROTO_MCP_EVENTS_REPOS`.
- **Principal isolation.** The origin acts as its own principal, `sessionPrincipal("mcp-events-origin")`, never the
  operator's daemon-bearer principal. Subscription ids derive from the principal, so the origin can only see and
  cancel subscriptions it created itself; the operator's subscriptions (made on `/mcp`) are untouched, and the other way
  round.
- **Credential.** The path secret is the only credential on this route; it grants nothing on `/mcp` or any other route.

### Tunnel ingress

A tunnel connects to the daemon from loopback, so any route it forwards would inherit the loopback bypass of the daemon
bearer. The tunnel ingress MUST forward only `^/mcp/events/`. cloudflared example:

```yaml
ingress:
  - hostname: <host>
    path: ^/mcp/events/
    service: http://127.0.0.1:18790
  - service: http_status:404
```

### Known limits

- JSON responses only (`Content-Type: application/json`); no SSE streams.
- No `subscriptions/listen` and no resource subscriptions (`resources/subscribe` is a 404 `-32601`).
- Only POST is accepted (OPTIONS, HEAD, GET, DELETE answer 405 with `Allow: POST`); request bodies are capped at 1 MiB.
- The root `/mcp` endpoint is unchanged: it still speaks the 2025-11-25 transport.
