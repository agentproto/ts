---
name: agentpush
description: >-
  Bridge an imported agentpush MCP server (Telegram, WhatsApp, etc.) with
  live agentproto sessions via the daemon's transmitter subsystem:
  transmit_message sends outbound and binds the recipient to a session,
  inbound_watcher_start polls agentpush for new messages, and
  inbound_endpoint_create/POST /inbound(/:slug) route inbound replies back
  into the SAME session instead of spawning a fresh agent every time. Use
  when wiring push notifications, chat-bot replies, or any inbound/outbound
  messaging channel (Telegram, WhatsApp, Slack, a generic webhook) into an
  agentproto agent.
metadata:
  tags: agentpush, transmitter, inbound, outbound, telegram, whatsapp, slack,
    webhook, mcp, agentproto, routing, sessions
---

# agentpush — the agentpush ⇄ agentproto transmitter

Bidirectional bridge between an imported **agentpush** MCP server (Telegram,
etc.) and live agentproto sessions: `transmit_message` sends outbound and
can bind the recipient to the sending session, and inbound replies from that
contact then route straight into the SAME session as a real user turn —
instead of spawning a brand-new agent for every reply.

Source: `packages/runtime/src/transmitter-bindings.ts`,
`inbound-adapters.ts`, `outbound-adapters.ts`, `inbound-router.ts`,
`inbound-watcher.ts`, the `inbound_*`/`transmit_message`/`telegram_bot_*`
tools in `orchestration-tools.ts`/`telegram-bot-creds.ts`, and the
`POST /inbound`(`/:slug`) routes in `http-server.ts`. Full reference:
`packages/runtime/docs/TRANSMITTER.md`.

## The model

One `TransmitterBindingStore` maps

```
(alias, source, contactRef) -> { sessionId, mode, provider?, lastSeenTs }
```

- `alias` — the imported MCP alias (agentpush) or bot-token alias (telegram).
- `source` — the channel/phone/chat id the message is scoped to.
- `contactRef` — the sender's id within that source.
- `sessionId` — the agentproto session future inbound replies from this
  contact should route into.
- `mode` — `"route"` or `"route-or-spawn"` (the mode this binding was
  created under).
- `provider` — the outbound provider the binding was created through
  (`"agentpush"`, `"telegram"`, …). Defaults to `"agentpush"`.

Bindings live in memory, persist (debounced write) to
`~/.agentproto/transmitter-bindings.json`, load on construct, and start
empty on a missing/corrupt file rather than throwing. One store instance is
shared across the poll watcher, `transmit_message`, and the inbound HTTP
routes.

## MCP tools that actually exist

All verified against `orchestration-tools.ts` / `telegram-bot-creds.ts` —
don't assume a verb exists beyond this list.

| tool | purpose |
|---|---|
| `transmit_message` | Send outbound through a provider; binds the recipient to a session by default. Registered only when both an MCP proxy and a binding store are wired. |
| `inbound_watcher_start` | Start a background poller against `poll_inbound` on an imported agentpush alias; spawns (or routes, per `mode`) per `contact_ref`. Returns a `watcherId`. |
| `inbound_watcher_stop` | Stop a watcher by id. Cursor position is preserved for a later restart. |
| `inbound_watcher_list` | List all watchers (running + stopped) with cursor, poll/fire times, spawn count. |
| `inbound_endpoint_create` | Create/update a provider-agnostic `POST /inbound/<slug>` webhook endpoint (dialect, alias, mode, optional signing secret). |
| `inbound_endpoint_list` | List endpoints. Secrets are never emitted. |
| `inbound_endpoint_delete` | Delete an endpoint by slug. |
| `telegram_bot_token_set` | Store/rotate a Telegram bot token (0600 file under `~/.agentproto/telegram-bot-creds/`), never echoed back. |
| `telegram_bot_token_status` | Check whether a token is configured (fingerprint/last4 only). |
| `telegram_bot_set_webhook` | Call Telegram's `setWebhook` for a bot alias using the stored token. |
| `mcp_import` | Prerequisite: import the agentpush MCP server under an alias before any tool above can use it. |

`inbound_watcher_*` requires an `inboundWatcher` to be wired on the daemon;
`transmit_message` requires both an MCP proxy and a binding store;
`inbound_endpoint_*` requires an `endpointStore`. On a daemon started
without one of these, the corresponding tools are simply absent — check
`tools/list`, don't assume.

## Outbound: `transmit_message`

```json
{
  "provider": "agentpush",
  "alias": "agentpush",
  "source": "+33600000000",
  "contact_ref": "alice",
  "text": "your PR is ready for review",
  "sessionId": "sess_abc123",
  "bind": true
}
```

- `provider` — default `"agentpush"`. Enum: `agentpush`, `telegram`,
  `whatsapp`, `slack`, `generic`, `native` — but only **`agentpush`** and
  **`telegram`** have a working `sendOutbound` implementation today; the
  other four return `{ sent: false, error: "unsupported_provider" }`
  (`outbound-adapters.ts`'s switch has no case for them on the send side,
  even though they're valid **inbound** dialects — send and receive support
  are NOT symmetric).
- `alias` — required for `agentpush`; defaults to `"default"` for
  `telegram`.
- `source` / `contact_ref` — channel/phone and recipient id (agentpush), or
  chat id (telegram, as `contact_ref`).
- `text` — required unless `attachments` is given.
- `attachments[]` — `{ type: photo|document|video|audio, path, caption? }`,
  local files; multiple become an album/media group where supported.
- `sessionId` — **required by the tool schema itself** (not merely "used
  when binding") — every call must pass one, even if you intend `bind:
  false`.
- `bind` — default `true`: upserts `(alias, source, contact_ref) ->
  sessionId` with `mode: "route-or-spawn"` and the resolved `provider`. A
  failed send (`sent: false`) never binds.
- Returns `{ sent: boolean, bound: boolean }`.

**agentpush** dispatch calls the imported alias's real `send_message` tool:
`{ to: { channel: source, address: contact_ref }, content: { text } }`.
Attachments are uploaded first via `upload_media` (`channel: source`), then
referenced in `content.media[]` by the returned `providerMediaId`.

**telegram** POSTs directly to the Bot API: `sendMessage` (text-only),
`sendPhoto`/`sendDocument`/`sendVideo`/`sendAudio` (one attachment),
`sendMediaGroup` (several). Text/captions are converted from Markdown to
Telegram's `MarkdownV2` (headers, bold, italic, strikethrough, code spans —
special chars auto-escaped) before sending. The bot token comes from
`telegram_bot_token_set`'s store, resolved by alias.

## Inbound routing modes

Both the poll watcher and `POST /inbound`(`/:slug`) share one decision
function, `routeInboundMessage` (`inbound-router.ts`):

| mode | binding + session alive | binding + session dead | no binding |
|---|---|---|---|
| `spawn` (poll watcher default) | *(ignored)* spawns fresh | *(ignored)* spawns fresh | spawns fresh |
| `route` | routes (`"routed"`) | resurrects, routes (`"restarted-routed"`) | skips (`"skipped"`) |
| `route-or-spawn` (webhook default) | routes | resurrects, routes | spawns if a spawn path is configured, else skips |

"Resurrects" = an agent-cli session that's no longer alive is restarted in
place (`restartAgentSession(..., { forceAgentResume: true })`, same
primitive the cron scheduler's `prompt-session` job uses); the reply lands
in the (possibly new) resulting session id. A session counts as alive
unless it's missing entirely or `processAlive === false` explicitly — a
pid-less ACP-native/remote session is treated as alive. Every successful
route refreshes the binding's `lastSeenTs`.

**Only the poll watcher spawns unbound contacts.** Neither the native
`POST /inbound` route nor a `POST /inbound/:slug` endpoint is ever wired
with a `spawnForContact` — an unauthenticated webhook payload carries no
adapter/prompt template to spawn with — so an unbound contact under
`route-or-spawn` on either HTTP path is `"skipped"`, not spawned. Only
`inbound_watcher_start` (which is configured with `adapter` +
`promptTemplate`) can spawn from an inbound event.

## `POST /inbound` — native push ingress

Bearer-gated exactly like the mutating `/sessions/*` routes (token from
`<workspace>/.agentproto/runtime.json`):

```
POST /inbound
Authorization: Bearer <token>
Content-Type: application/json

{
  "alias": "agentpush",
  "source": "+33600000000",
  "contact_ref": "alice",
  "text": "sounds good, ship it",
  "messages": [ /* optional: raw agentpush events */ ],
  "mode": "route-or-spawn"        // optional, default
}
```

- `200 { "action": "routed"|"spawned"|"restarted-routed"|"skipped", "sessionId"?: string }`
- `400` — missing `alias`/`source`/`contact_ref`/`text`, or an invalid `mode`.
- `401` — missing/invalid bearer token.
- `501 { "error": "inbound_routing_not_configured" }` — the daemon wasn't
  wired with a `routeInboundMessage` handler.

## `POST /inbound/:slug` — provider-agnostic webhook endpoints

Configured via `inbound_endpoint_create` (dialect, imported alias, optional
forced `source`, optional signing `secret`, routing `mode`). Managed
endpoints share the same `routeInboundMessage` router as the poll watcher
and the native route.

- `404 { "error": "unknown_inbound_endpoint" }` — unknown slug, or the
  endpoint exists but `enabled: false`.
- **When a secret is configured**, it's REQUIRED and the sessions bearer
  gate is bypassed (so a public webhook isn't accidentally opened by the
  loopback Origin allowlist). **When no secret is configured**, the route
  falls back to the same sessions bearer gate as the native route — a
  webhook endpoint is never silently unauthenticated either way.
- Signature verification per provider:

  | provider | header | format |
  |---|---|---|
  | `agentpush` | `X-Agentpush-Signature` | `sha256=<hex-hmac-sha256>` |
  | `telegram` | `X-Telegram-Bot-Api-Secret-Token` | exact secret, constant-time |
  | `whatsapp` | `X-Hub-Signature-256` | `sha256=<hex-hmac-sha256>` |
  | `slack` | `X-Slack-Signature` | Slack v0 signature + 5-minute replay window |
  | `generic` | `X-Agentproto-Signature` | `sha256=<hex-hmac-sha256>` |
  | `native` | n/a | uses the sessions bearer gate (not applicable to `:slug` endpoints) |

- Bad/missing signature → `401 { "error": "bad_signature", "reason": ... }`.
- After verification, `normalizeInbound()` maps the provider's raw webhook
  body to `{ alias, source, contactRef, text, messages? }`. `agentpush` and
  `slack` handle a `challenge` handshake (`200 { "challenge": "..." }`, no
  session touched). `telegram` and `slack` ignore bot/self messages.
  Missing text → `200 { "action": "ignored", "reason": "no_text" }` (so the
  provider doesn't retry forever) rather than an error.
- A `?mode=spawn|route|route-or-spawn` query param overrides the endpoint's
  configured mode per-request.
- Dedup: each endpoint keeps an in-memory FIFO of the last ~500 seen
  provider message ids (global cap ~5000 across all endpoints); a repeat →
  `200 { "action": "duplicate" }`. In-memory only — a daemon restart
  re-accepts anything a provider redelivers.
- `501 { "error": "inbound_routing_not_configured" }` — same as the native
  route, if `routeInboundMessage` isn't wired.

## Simulating an inbound message

```sh
pnpm --filter @agentproto/runtime sim:inbound
# or with overrides:
pnpm --filter @agentproto/runtime sim:inbound -- --contact=bob --text="ping from bob"
```

`packages/runtime/scripts/simulate-inbound.mjs` wires the real
`SessionsRegistry`, `TransmitterBindingStore`, `routeInboundMessage`, and
`startHttpServer` in-process, with one fake session standing in for a real
adapter — so you see the whole path (HTTP → routing → the session
receiving the turn) with no live agentpush server or daemon required. Flags
(or env `ALIAS`/`SOURCE`/`CONTACT`/`TEXT`/`SESSION_ID`/`PORT`/`TOKEN`):
`--alias`, `--source`, `--contact`, `--text`, `--session-id`, `--port`,
`--token`. Exits non-zero if the HTTP response or the delivered text
doesn't match expectations.

## Telegram bot wiring recipe

1. Create the bot with @BotFather, copy the token.
2. `telegram_bot_token_set` `{ token }` (alias `"default"` unless running
   multiple bots).
3. `inbound_endpoint_create` `{ slug, provider: "telegram", alias, mode:
   "route-or-spawn" }` — response includes the generated `secret`.
4. Start a public ingress proxy, get its public URL.
5. `telegram_bot_set_webhook` `{ url: "https://<proxy>/inbound/<slug>",
   secret_token: "<endpoint-secret>" }`.

## Gotchas

- **`transmit_message.sessionId` is not conditionally required** — the tool
  schema requires it on every call, `bind: false` or not.
- **Telegram's binding `source` is the literal string `"telegram"`**, never
  the chat id — collapsing it to the chat id would collide with
  `contactRef` in the `(alias, source, contactRef)` key and break every
  lookup written via `transmit_message` (which always sends
  `source: "telegram"`). This is an explicit code comment in
  `inbound-adapters.ts`, not an accident.
- **Send/receive dialect support isn't symmetric.** `whatsapp`/`slack`/
  `generic`/`native` are valid **inbound** webhook dialects but have no
  outbound `sendOutbound` case — `transmit_message` with those providers
  always fails with `unsupported_provider`.
- **A failed send never binds** — check `sent` before trusting `bound`.
- **Native `POST /inbound` and per-slug endpoints never spawn** unbound
  contacts; only `inbound_watcher_start` can, because only it carries an
  `adapter`/`promptTemplate` to spawn with.
- **Endpoint secrets gate signature verification, not the bearer gate
  outright** — configuring a secret trades the sessions bearer gate for
  HMAC/signature verification; omitting it keeps the bearer gate. There is
  no endpoint mode that skips both.
- **This repo only implements the ingress side.** For inbound push to fire
  in production without the 5-second poll loop, agentpush itself must be
  configured to `POST` its webhook payload to `<daemon-url>/inbound` (or a
  configured `/inbound/:slug`) with the daemon's bearer token — that
  configuration lives outside this repo.
- **Wiring an agentpush API key without leaking it into every agent's env**
  is a job for the credential broker, not a raw env var — see [[auth]]
  (worked example there uses agentpush itself: `credentialRef` on an
  `agent_start.mcpServers[]` entry resolves to a fresh `Authorization`
  header at spawn time).
