# MCP Events — test checklist

> Ready-to-run checklist. Each row maps to a Contract Map §2 entry and a
> grep-able test name. Run: `pnpm test` in `packages/runtime` (or the full
> monorepo gate). Test names are grep-able via
> `rg '<test-name>' packages/runtime/src/__tests__/`.

## Transport

- [ ] `discover-exposes-events-capability` — `server/discover` returns `events:{}` in capabilities

## events/list

- [ ] `events-list-tenant-scoped` — registry filters definitions by principal's reachable schemes
- [ ] `events-list-pagination` — `cursor` query param; opaque token = offset+scheme checkpoint; `nextCursor` returned

## Subscription identity

- [ ] `sub-id-canonical-jcs` — sha256 over RFC 8785 (JCS) canonical JSON; recursive key sort, Unicode minimization, ECMAScript number serialization
- [ ] `sub-id-no-duplicate` — same identity = upsert, never duplicate

## Callback verification (challenge)

- [ ] `challenge-success` — 2xx with matching challenge body → ok
- [ ] `challenge-fail-reason-categorized` — each failure reason has a dedicated assertion: `challenge_failed`, `timeout`, `non_https`, `ssrf_blocked`, `non_2xx`
- [ ] `challenge-cache-hit` — second verify with same (principal, url, secret) resolves from cache
- [ ] `challenge-new-secret-bypasses-cache` — a new secret during rotation ALWAYS forces re-verification

## SSRF

- [ ] `ssrf-blocks-private` — private/loopback/CGNAT/link-local addresses blocked
- [ ] `ssrf-no-redirect` — 3xx returned as-is, not followed
- [ ] `ssrf-same-fn-both-paths` — challenge AND delivery use the same `ssrfFetch()` (I3)

## Envelope mapping

- [ ] `envelope-mapping` — CloudEvents `SentinelEvent` → `eventId/name/data/timestamp/cursor`; `id→eventId` (and `webhook-id` header), `type→name`, `data→data`, `time→timestamp`

## Signing

- [ ] `sign-body-once` — body serialized once; caller owns bytes; signing never re-serializes
- [ ] `retry-keeps-bytes` — retry re-signs with new timestamp; signature header DIFFERS but body identical
- [ ] `dual-sign-during-rotation` — during rotation window, `webhook-signature` carries two `v1,<b64>` segments (space-separated)

## Delivery

- [ ] `payload-clamp-256kib` — oversize `data` replaced with `{summary, subject}` + `truncated: true`
- [ ] `delivery-2xx-ack` — 2xx = delivered
- [ ] `retry-backoff-bounded` — exponential backoff, max 5 attempts
- [ ] `retry-new-signature` — fresh timestamp + signature per attempt
- [ ] `no-retry-410-413` — 410 and 413 are terminal (no retry)

## TTL / refresh

- [ ] `ttl-clamp` — omitted → 7d; `number` → `min(requested, 30d)` with 60s floor
- [ ] `refresh-before-expires` — `refreshBefore` = `until.ms` as ISO-8601 (granted expiration, not a hint)
- [ ] `ttl-null-no-refresh-needed` — `ttlMs: null` → `until:{kind:"never"}` → `refreshBefore: null`
- [ ] `rotation-window-both-secrets` — subscribe-refresh writes new secret; delivery signs with both while window open

## Replay (v1 reality)

- [ ] `unreplayable-cursor-null` — ALL event definitions non-replayable; subscribe/refresh always return `cursor: null`; `truncated` never set

## Unsubscribe

- [ ] `unsubscribe-idempotent` — same event name + args + URL → same deterministic id; second call returns `{}`

## Filters

- [ ] `filters-applied-server-side` — `SentinelSpec.match` clauses (subject prefix + type globs) applied server-side

## Outbox / persistence

- [ ] `outbox-resume-post-restart` — `resumeWebhookDeliveries()` re-enqueues pending rows by exact bytes
- [ ] `outbox-ack-after-terminal` — sentinel event marked seen/acked only after outbox row reaches terminal status
- [ ] `outbox-reap-24h` — delivered rows reaped after 24h

## Secret redaction

- [ ] `sentinel-view-redacts-secret` — `sentinelView()` outputs `{kind:"webhook", url, hasSecret:true, secretRedacted:true}`; raw secret never in listing/get view
