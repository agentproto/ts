# MCP Events integration

> The agentproto daemon is OpenAI MCP Events compatible: native JSON-RPC
> methods `events/list`, `events/subscribe`, `events/unsubscribe` on the
> authenticated `/mcp` endpoint, plus an `events:{}` capability at
> `initialize`. It also serves the MCP Events extension
> (`io.modelcontextprotocol/events`, SEP-3415, protocol 2026-07-28):
> `events/poll` on both eras, `events/stream` (SSE push) on the 2026-07-28
> era, the official `-32023`..`-32027` codes and the `Mcp-Name` header.
> `initialize` never advertises the 2026-07-28 era; a request selects it
> (`MCP-Protocol-Version` header or body `_meta`), and that era serves
> `server/discover`. The draft AIP-76 (`mcp-events/v1`) carries the contract; §8
> below covers poll and stream.
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
| `events:{}` capability advertised at `initialize`, with `capabilities.extensions["io.modelcontextprotocol/events"] = {listChanged:false}` beside it while `mcp.eventsExtension` is on; on the 2026-07-28 era the same capabilities come from `server/discover` (the legacy SDK server never registers `server/discover`, FIX-10 / #1508) | the TRANSPORT's capabilities object, not the adapter | `packages/mcp-server` (request handling) | `discover-exposes-events-capability` |
| `events/list` — stable `name`, specific `description`, `inputSchema` (filters), `payloadSchema` | EventDefinition, declared **per provider scheme** from `defaultTypes()` + a hand-written payload map per scheme (W-B1) | `mcp-events/events-registry.ts` | `events-list-tenant-scoped`, `events-list-pagination` |
| server-side filter application | `SentinelSpec.match` clauses (subject prefix + type globs) | `sentinel-store.ts` (exists) | existing store tests + `filters-applied-server-side` |
| only tenant-visible events | registry filters definitions by principal's reachable schemes | `events-registry.ts` | merged into `events-list-tenant-scoped` |
| `nextCursor` pagination | `cursor` param on `events/list`, opaque token = offset+scheme checkpoint; `nextCursor` is omitted on the last page (never `null`) | `mcp-events/adapter.ts` (`eventsList`) | merged into `events-list-pagination` |
| `delivery` per definition | the modes the answering surface serves: `["poll","push","webhook"]` on the 2026-07-28 era while `events/stream` is served, `["poll","webhook"]` on 2025-11-25 or with `mcp.eventsStream:false`, `["webhook"]` with `mcp.eventsExtension:false` | `mcp-events/adapter.ts` (`pollEnabled`, `pushEnabled`), `mcp-events-surface.ts` (`registerPushAwareEventsList`) | `mcp-events-poll.test.ts`, `mcp-modern-contract-live.test.ts` |
| deterministic subscription id (principal + callback URL + event name + args, canonical JSON) | `subscriptionId(subInput)` — sha256 over **RFC 8785 (JCS) canonical JSON** (full spec: recursive key sort, Unicode minimization, ECMAScript number serialization; args payload is trustless input, nested objects legal); same identity = **upsert**, never duplicate | `mcp-events/subscription-id.ts` | `sub-id-canonical-jcs`, `sub-id-no-duplicate` |
| callback verification (challenge POST, signed, one-shot, short TTL) | `verifyCallback()` — 2xx required, constant-time compare, keyed cache per **(principal + normalized callback URL + sha256(secret)) — a NEW secret during rotation ALWAYS forces re-verification (the cache can never bless an unverified secret)**, bounded TTL 10 min | `webhook-egress/challenge.ts` | `challenge-success`, `challenge-fail-reason-categorized`, `challenge-cache-hit`, `challenge-new-secret-bypasses-cache` |
| `CallbackEndpointError -32027` + `data.reason` | JSON-RPC error on subscribe; `reason ∈ {connection_refused, timeout, tls_error, http_4xx, http_5xx, challenge_failed}` (the spec's `lastError` categories), translated from `ChallengeFailureReason` at the MCP boundary; the old value rides in `data.legacyReason`, `-32015` in `data.legacyCode`, for one release; the message is a fixed sentence per category (no host, address, status or response text). A non-`https` or malformed `delivery.url` is `-32602` `invalid_callback_url`, before any network call | `mcp-events/adapter.ts` (`callbackEndpointError`) | `challenge-fail-reason-categorized`, `callback-fail-reason-categorized` |
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
| client refresh before expiry (same sub identity + last cursor) | upsert path reuses existing sub id; returns new `refreshBefore` = new `until.ms`; a cursor is decoded but not replayed over the webhook: `cursor: null` back, `truncated: true` | `mcp-events/adapter.ts` | merged into `refresh-before-expires` |
| replay via `cursor`; `truncated` when history gone | Providers have no historical replay (`local-gh` polls by snapshot diffing), so replay comes from the daemon's own **poll journal** (§8), fed by a shared watch lease: `events/poll` and `events/stream` replay from a cursor and say `truncated: true` when the journal no longer covers it. Webhook subscriptions do not replay: subscribe/refresh return `cursor: null`; a supplied `cursor` is decoded like a poll cursor (`-32602` unreadable, `-32024` another caller's) and answers `truncated: true`. | `mcp-events/adapter.ts`, `mcp-events/poll-journal.ts`, `mcp-events/stream.ts` | `unreplayable-cursor-null`, `mcp-events-poll.test.ts`, `mcp-events-stream.test.ts` |
| `events/unsubscribe` with same event name + args + URL; idempotent | remove-by-deterministic-id path; second call returns `{}` (not `-32023`); `delivery.mode` may be omitted; no `https` check, so any subscription can be removed | `mcp-events/adapter.ts` | `unsubscribe-idempotent` |
| `Mcp-Name` header (2026-07-28 era) | must equal `params.name` on `events/subscribe`, `events/unsubscribe`, `events/poll`, `events/stream`; missing or different = `-32020` (HTTP 400) | `mcp-modern/constants.ts` (`NAME_HEADER_SOURCE`), `mcp-modern/validate.ts` | `mcp-modern-contract-live.test.ts`, `mcp-events-stream-http.test.ts` |
| delivery ordering non-guaranteed; consumer idempotence | I1 dedup + docs note (W-D) | docs | — |
| bursts / batching, `read` retrieval of full record | **explicitly cut** (see §5) — ChatGPT treats 2xx accept async; we only promise body shape | — | — |

Anything new anyone builds downstream MUST add a row to this table + a test row.

## 3. Explicitly NOT supported (v1)

The following are **explicitly cut** from v1. Do not attempt to use them;
they will not work and are not planned for this release.

| Cut | Why |
|---|---|
| **Control envelopes over the webhook** (`gap`, `terminated`) | Not sent over the webhook. (`events/stream` has its own `notifications/events/*`, §8.) |
| **`deliveryStatus`** in the subscribe/refresh result | Optional in the extension; not returned. |
| **`subscriptions/listen`** | Not served; `listChanged` is `false` everywhere and the 2026-07-28 `server/discover` drops `listChanged` from `tools`, `resources` and `prompts`. |
| **Event batching** across subscribers | One event per POST. The client may group server-side. |
| **ChatGPT plugin manifest** | Their side handles discovery; we only need the capability flag + methods. |
| **`read` tool** for oversized payloads | The 256 KiB clamp reduces `data` to `{summary, subject}`. A full-read tool is a follow-up (W-F) only if real usage demands it. |
| **Replay via cursor over the webhook** | Webhook subscriptions do not replay: subscribe/refresh return `cursor: null`, and answer `truncated: true` when the client supplied a cursor. Use `events/poll` or `events/stream` to replay (§8). |
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

`ChallengeFailureReason` keeps its values (the sentinel webhook surface uses
them); `callbackEndpointError` translates them for `-32027`, using the HTTP
status and the `ssrfFetch` cause the challenge outcome carries. The old value
is kept in `data.legacyReason` for one release.

| `ChallengeFailureReason` (cause / status) | JSON-RPC `data.reason` |
|---|---|
| `challenge_failed` | `challenge_failed` |
| `timeout` (`timeout`) | `timeout` |
| `timeout` (`connect`) | `connection_refused` |
| `ssrf_blocked` (`private_target`, `redirect`) | `connection_refused` |
| `non_https` | `connection_refused` (unreachable on subscribe: `delivery.url` is checked first, `-32602`) |
| `non_2xx` (5xx) | `http_5xx` |
| `non_2xx` (any other status) | `http_4xx` |

`tls_error` is never emitted: `ssrfFetch` reports a TLS failure as `connect`.

### JSON-RPC error codes

| Code | Meaning |
|---|---|
| `-32602` | Invalid params: bad args vs `inputSchema`, bad secret, TTL, cursor, `maxAgeMs`, `heartbeatMs`, or a non-`https` `delivery.url` (`invalid_callback_url`) |
| `-32023` | NotFound: unknown event type, `data.kind: "event"` |
| `-32024` | Forbidden: not authorized, a cursor issued to another caller (`cursor_principal_mismatch`), or a repo outside the public origin's allowlist |
| `-32025` | ResourceExhausted: `data.limit` names the limit, `data.max` its ceiling. `pollWatches` (shared watch pool, `poll_watch_quota`, poll and stream alike) or `streams` (32 open streams) |
| `-32026` | Unsupported: `data.feature: "deliveryMode"`, `data.value` the refused mode (for example `push` on a type that does not offer it), or a provider that is unavailable |
| `-32027` | `CallbackEndpointError`: challenge verification failed. `data.reason` is a `lastError` category; the pre-standard `-32015` rides in `data.legacyCode` for one release |
| `-32603` | `BackingSubscriptionError` (`data.kind: "backing_subscription"`, the pre-standard `-32016` in `data.legacyCode` for one release): a refresh could not renew the backing remote subscription. `data.reason`: `backing_subscription_expired` (remote already expired/deleted: unsubscribe and subscribe again; local state is untouched and no second remote is provisioned) or `backing_renew_failed` (transient: retry the refresh) |

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
| `AGENTPROTO_MCP_EVENTS_REPOS` | Comma-separated `owner/repo` allowlist. A subscribe, poll or stream whose `arguments.repo` is not listed is refused (`-32024`, before any watch or stream opens); empty = every one is refused. |
| `AGENTPROTO_MCP_EVENTS_ORIGINS` | Comma-separated browser `Origin` values to accept. Default none: any request carrying an `Origin` header is a 403. A request with no `Origin` is allowed. |

URL shape: `https://<host>/mcp/events/<secret>`. A wrong, missing or malformed secret segment answers `404`
`{"error":"not_found"}` with `cache-control: no-store`.

### Surface

Exactly `server/discover`, the `events/*` methods (`events/list`, `events/subscribe`, `events/unsubscribe`,
`events/poll`, and `events/stream` while `mcp.eventsStream` is on) and one probe tool, `events_ping`. No other tools, resources or prompts are reachable here; the server is built from scratch for
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

- JSON responses, except `events/stream`, which answers `text/event-stream` (§8). A tunnel that holds a streamed
  response until it ends delivers nothing over `events/stream`: use `events/poll` behind such a tunnel.
- No `subscriptions/listen` and no resource subscriptions (`resources/subscribe` is a 404 `-32601`).
- Only POST is accepted (OPTIONS, HEAD, GET, DELETE answer 405 with `Allow: POST`); request bodies are capped at 1 MiB.
- The root `/mcp` endpoint serves both eras: 2025-11-25 through `initialize`, 2026-07-28 when the request names it.

## 8. Pull and push reads (`events/poll`, `events/stream`)

Both read one **journal** per `(name, arguments)` key (`mcp-events/poll-journal.ts`), fed by a shared provider watch
(a **lease**, `mcp-events/poll-lease.ts`). Neither is a new source of events, and the webhook outbox is not involved.

| Fact | Value |
|---|---|
| Journal | append-only JSONL, dedup on `eventId`, a `gap` entry when continuity is lost (a new watch after a restart); retention 24 h, at most 5000 entries; purged every 10 min, not only at boot |
| Lease | opened by the first read of a key, reused after; released after 5 min without a read; at most 64 (`-32025` `pollWatches`); an open stream holds its lease, so it is never released for idleness; pump every 15 s |
| Cursor | opaque, bound to the caller (`-32024` for another caller's), interchangeable: a poll cursor resumes a stream and a stream cursor resumes a poll |
| `truncated` | `true` when a read starts later than its cursor (retention, `maxAgeMs`, gap, replaced journal); never an error |
| `events/poll` | `{name, arguments, cursor?, maxAgeMs?, maxEvents?}` (default 100, max 1000) → `{events, cursor, truncated, hasMore, nextPollMs}` |
| `events/stream` | 2026-07-28 era only. `{name, arguments, cursor?, maxAgeMs?, heartbeatMs?}`; `Accept` must allow `text/event-stream` (else 406); one `data: <json>` SSE frame per message, no `id:` line, no comment |
| Stream messages | `notifications/events/active` first (`cursor`, `truncated`, granted `heartbeatMs`) and again after a gap; `notifications/events/event` per event with its `cursor`; `notifications/events/heartbeat` (`cursor`) after each silence of `heartbeatMs`; `notifications/events/error` (`-32603` `UpstreamError`, `data.reason` a category) on a provider failure, stream stays open; `notifications/events/terminated` then the final frame if the type leaves the registry or access is revoked (does not fire with today's static registry) |
| Stream `_meta` | every message carries `params._meta["io.modelcontextprotocol/subscriptionId"]` = the request's JSON-RPC `id` |
| Heartbeat | default 30 000 ms, clamped to [5 000, 60 000] |
| Stream limits | 32 open streams (`-32025` `streams`); a write that does not drain in 10 s closes the stream (resume from the cursor) |
| Stream end | client abort: no result frame, the lease hold is released; daemon shutdown: final `{id, result:{resultType:"complete"}}` then close |
| Errors | every validation error is a plain JSON-RPC error before any SSE frame (no stream is opened) |
| Switches | `mcp.eventsExtension` (default on): off = no poll, no stream, no extension declared. `mcp.eventsStream` (default on, read only while the extension is on): off = `events/stream` answers 404 `-32601` and `push` leaves `delivery` |

Tests: `mcp-events-poll.test.ts`, `mcp-events-stream.test.ts` (engine, injected timers),
`mcp-events-stream-http.test.ts` (real HTTP server), `mcp-events-surface.test.ts`, `mcp-modern-contract-live.test.ts`;
fixtures `__tests__/fixtures/mcp-2026-07-28/events-*.json` are copied from the extension text.
