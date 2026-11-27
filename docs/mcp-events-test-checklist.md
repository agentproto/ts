# MCP Events — test checklist

> Ready-to-run checklist. Each row maps to a Contract Map §2 entry and a
> grep-able test name. Run: `pnpm test` in `packages/runtime` (or the full
> monorepo gate). Test names are grep-able via
> `rg '<test-name>' packages/runtime/src/__tests__/`. Section
> [Validation réelle](#validation-réelle-v-1-live-2026-10-02) en bas : rapport
> du probe live V-1 (daemon réel + events qui remontent).

## Transport

- [ ] `discover-exposes-events-capability`: `initialize` (2025-11-25) and `server/discover` (2026-07-28) return `events:{}`, plus `extensions["io.modelcontextprotocol/events"] = {listChanged:false}` while the extension is on
- [ ] modern `server/discover` carries no `listChanged` on `tools`, `resources` or `prompts` (`mcp-modern-contract-live.test.ts`)
- [ ] `Mcp-Name` = `params.name` on subscribe, unsubscribe, poll and stream; missing or different is `-32020` HTTP 400 (`mcp-modern-contract-live.test.ts`, `mcp-events-stream-http.test.ts`)

## events/list

- [ ] `events-list-tenant-scoped` — registry filters definitions by principal's reachable schemes
- [ ] `events-list-pagination`: `cursor` param; opaque token = offset+scheme checkpoint; `nextCursor` returned, and omitted on the last page
- [ ] `delivery` names the served modes: `push` on the 2026-07-28 era only while `events/stream` is served; the legacy era lists `["poll","webhook"]` (`mcp-events-poll.test.ts`, `mcp-modern-contract-live.test.ts`)

## Subscription identity

- [ ] `sub-id-canonical-jcs` — sha256 over RFC 8785 (JCS) canonical JSON; recursive key sort, Unicode minimization, ECMAScript number serialization
- [ ] `sub-id-no-duplicate` — same identity = upsert, never duplicate

## Callback verification (challenge)

- [ ] `challenge-success` — 2xx with matching challenge body → ok
- [ ] `challenge-fail-reason-categorized`: each failure reason has a dedicated assertion: `challenge_failed`, `timeout`, `non_https`, `ssrf_blocked`, `non_2xx` (the challenge's own reasons; on the MCP wire `-32027` carries `connection_refused`, `timeout`, `http_4xx`, `http_5xx` or `challenge_failed`, the old value in `data.legacyReason`, and a non-`https` `delivery.url` is `-32602` `invalid_callback_url`)
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

## Replay

- [ ] `unreplayable-cursor-null`: webhook subscribe/refresh return `cursor: null`; a supplied cursor is decoded like a poll cursor (`-32602` unreadable, `-32024` another caller's) and answers `truncated: true`

## events/poll (`mcp-events-poll.test.ts`)

- [ ] reads the journal after the cursor; `hasMore`, `nextPollMs`, `maxEvents` (default 100, max 1000)
- [ ] `truncated: true` when retention, `maxAgeMs` or a gap leaves the cursor behind
- [ ] a cursor issued to another caller is `-32024`
- [ ] an unfed journal is purged by the periodic purge, without a restart
- [ ] `-32025` `data: {reason:"poll_watch_quota", limit:"pollWatches", max}` when the watch pool is full (`mcp-events-codes.test.ts`)

## events/stream (`mcp-events-stream.test.ts`, `mcp-events-stream-http.test.ts`)

- [ ] `notifications/events/active` is the first message, with the granted `heartbeatMs` (default 30 000, clamped to [5 000, 60 000])
- [ ] a cursor replays in order; a poll cursor resumes a stream and the reverse
- [ ] a gap mid-stream sends a second `active` with `truncated: true`
- [ ] heartbeat only after a silence of `heartbeatMs`, carrying the head cursor
- [ ] a provider failure sends `notifications/events/error` and the stream stays open
- [ ] client abort releases the lease hold and the journal listener; an open stream keeps its watch past the idle TTL
- [ ] the 33rd stream is `-32025` `limit:"streams"`; a full watch pool is the same `-32025` as poll
- [ ] validation errors (`-32602`, `-32023`, `-32024`, `-32026`) are JSON errors, no SSE frame
- [ ] HTTP: `text/event-stream`, `x-accel-buffering: no`, one `data:` frame per message, no `id:` line, no comment; `Accept` without `text/event-stream` is 406; shutdown sends the final frame; `mcp.eventsStream:false` is 404
- [ ] public origin: a stream outside the repo allowlist is `-32024` before any watch opens (`mcp-events-surface.test.ts`)

## Unsubscribe

- [ ] `unsubscribe-idempotent`: same event name + args + URL → same deterministic id; second call returns `{}`; an `http://` subscription can still be removed

## Filters

- [ ] `filters-applied-server-side` — `SentinelSpec.match` clauses (subject prefix + type globs) applied server-side

## Outbox / persistence

- [ ] `outbox-resume-post-restart` — `resumeWebhookDeliveries()` re-enqueues pending rows by exact bytes
- [ ] `outbox-ack-after-terminal` — sentinel event marked seen/acked only after outbox row reaches terminal status
- [ ] `outbox-reap-24h` — delivered rows reaped after 24h

## Secret redaction

- [ ] `sentinel-view-redacts-secret` — `sentinelView()` outputs `{kind:"webhook", url, hasSecret:true, secretRedacted:true}`; raw secret never in listing/get view

## Validation réelle (v1 live run — 2026-10-02)

Preuve hors-tests, exécutée sur un daemon réel servi depuis le build worktree
(`packages/cli/dist/cli.mjs`, port 18791, séparé du daemon de prod) :

- **Capability + liste live** — `initialize`/`server/discover` sur `/mcp`
  renvoie `capabilities.events:{}`; `events/list` (JSON-RPC natif, POST curl)
  liste les 4 définitions avec wire shape verbatim (`name`, `description`,
  `delivery:["webhook"]`, `inputSchema` repo/number, `payloadSchema` CloudEvents).
- **Subscription réelle** — `events/subscribe` (`github.pull_request.closed`,
  repo `agentiknet/merge-gate-sandbox#3`, `ttlMs:null`) : challenge signé envoyé
  au récepteur derrière un tunnel cloudflared HTTPS public (le filtre SSRF
  bloque le loopback, donc URL publique obligatoire — by-design), echo `<200>`,
  header `x-mcp-subscription-id` présent; row créée dans `sentinels.json` avec
  `secretRef` (secret jamais exposé dans les listings — `secretRedacted:true`).
- **Event + delivery réels** — fermeture de la PR réelle → poll local-gh →
  outbox webhook → POST signé reçu par le récepteur INDEPENDANT qui VÉRIFIE
  lui-même la signature Standard Webhooks (HMAC `webhook-id|timestamp|body`):
  `evt_9f73e7238ffee55ee7ebcae9`, envelope verbatim
  (`eventId/name/timestamp/data/cursor:null`), `signature: VALID`, 2 s après
  le close (poll 60 s → 15 s actif).
- **Unsubscribe réel** — `events/unsubscribe` renvoie `{}` idempotent; la row
  disparaît du store ET de la listing; un re-close de la PR après unsubscribe
  ne déclenche AUCUN delivery (count figé).
- **Client externe (codex CLI)** — codex (0.157.0, transport streamable http +
  bearer) atteint le daemon et invoque les méthodes naties `events/list`,
  `events/subscribe`, `events/unsubscribe` avec les réponses JSON attendues
  (`sub_…/refreshBefore/cursor:null`, `{}`, -32602 catégorisée sur secret
  invalide). Transcript : `/tmp/codex-probe-results.json` (boxe les réponses
  brutes + la delivery VÉRIFIÉE).
- **Régression fixée pendant la validation** — `ssrf-sends-original-host-header`:
  la connexion par IP pré-validée utilisait l'IP comme header HTTP Host — les
  vhosts (edge cloudflared/CF testé live) répondaient 403/421 → tout subscriber
  name-based aurait été catégorisé `non_2xx` à tort. Fix + test de régression
  dans le même PR que W-C/W-E.

## Validation réelle (V-1, live 2026-10-02)

Rapport de la validation hors-tests (daemon réel servi depuis le build de la
branch W-C, endpoints `/mcp` natifs, transport streamable-HTTP + bearer) :

- [x] `server/discover` expose bien `events:{}` en plus de tools/resources sur
  le daemon réel (port 18791, build indépendant du prod).
- [x] `events/list` renvoie les 4 définitions github réelles du registry
  (`github.pull_request.closed`, `github.pull_request.synchronize`,
  `github.pull_request_review.submitted`, `github.check_suite.completed`)
  avec description/delivery/inputSchema/payloadSchema complets.
- [x] `events/subscribe` effectue le challenge signé standard借着 webhook-id /
  webhook-timestamp / webhook-signature / X-MCP-Subscription-Id → récepteur
  local derrière un tunnel cloudflared (URL publique HTTPS requise — le filtre
  SSRF bloque le loopback sur le chemin réel, by design). Le récepteur répond
  200 en écho `{"challenge":"…"}`.
- [x] Event RÉEL : la fermeture de la PR `agentiknet/merge-gate-sandbox#3`
  (provider local-gh) charge l'outbox → POST signé reçu, signature re-vérifiée
  indépendamment (`VALID`) par le récepteur, envelope verbatim
  (`eventId/name/timestamp/data/cursor:null`).
- [x] `events/unsubscribe` → `{}` idempotent, row supprimée du store ; le
  re-close de la PR après désabonnement ne génère plus aucune delivery.
- [x] `refreshBefore` = `null` (sub `ttlMs` null = never), conforme §2 row.
- [x] listing sentinel redactions : la row webhook est vue avec
  `hasSecret: true, secretRedacted: true`, aucun secret sur le listing.

**Régression détectée et fixée pendant V-1** : `ssrf-sends-original-host-header`
— `rawPost` liait l'HTTP Host header à l'IP connectée ; tout vhost (ex. edge
cloudflared) répondait 403/421 → faussement catégorisé `non_2xx`. Fix sur PR
#1673 avec test dédié (`ssrf-sends-original-host-header`).

Limites honnêtes du probe :
- codex CLI (0.157.0) atteint le daemon via streamable-HTTP + bearer et appelle
  les 3 méthodes natives, mais son sandbox local bloque l'accès à 127.0.0.1
  sans `network_access=true` et il ne lit pas l'env `MCP_EVENTS_SECRET` dans la
  sandbox — secret passé inliné dans les prompts (transcript `/tmp/codex-probe*-results.json`).
- la symétrie sentinel ↔ mcp-events est prouvée par le code (même
  `SentinelStore`, même outbox, même runtime de poll) — pas re-provoquée via la
  CLI `sentinel watch` dans le probe live.
