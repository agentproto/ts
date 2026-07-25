# The agentpush ⇄ agentproto transmitter

Bidirectional bridge between an imported agentpush MCP server (Telegram,
etc.) and a live agentproto session: outbound sends can bind a contact to
the session that sent them, and inbound replies from that contact then
route straight into the SAME session — as a real user turn — instead of
spawning a brand-new agent every time.

## The model

A single `TransmitterBindingStore` (`transmitter-bindings.ts`) maps

```
(alias, source, contactRef) -> { sessionId, mode, provider?, lastSeenTs }
```

- `alias` — the imported MCP alias (agentpush) or bot token alias (telegram).
- `source` — the channel/phone/chat id the message is scoped to.
- `contactRef` — the sender's id within that source.
- `sessionId` — the agentproto session future inbound replies from this
  contact should route into.
- `mode` — the routing mode this binding was created under (`"route"` or
  `"route-or-spawn"; see below).
- `provider` — the outbound provider this binding was created through
  (`"agentpush"`, `"telegram"`, etc.). Defaults to `"agentpush"` for
  backward compatibility.

One shared store instance is constructed in `index.ts` and injected into
three places: the inbound poll watcher, the `transmit_message` tool, and
the `POST /inbound` push route. Bindings persist (debounced JSON write) to
`~/.agentproto/transmitter-bindings.json`, load-on-construct, and start
empty on a missing/corrupt file rather than throwing.

## Outbound provider abstraction

`sendOutbound` in `outbound-adapters.ts` is the provider-agnostic send primitive.
It mirrors `inbound-adapters.ts` on the read side: a single dispatch function
that branches by `OutboundProvider` ("agentpush", "telegram", "whatsapp",
"slack", "generic", "native"). Adding a new outbound dialect means adding a case
to the switch in `sendOutbound` — the MCP tool and HTTP routes stay unchanged.

## Outbound: `transmit_message`

MCP tool that sends a message out through a provider-specific outbound channel
and, by default, binds the recipient to the calling session:

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

- `provider` — optional, defaults to `"agentpush"`. Supported values:
  `"agentpush"`, `"telegram"`, `"whatsapp"`, `"slack"`, `"generic"`, `"native"`.
- `alias` — for `agentpush`, the imported MCP alias (required). For
  `telegram`, the bot-token alias (defaults to `"default"`).
- `source` — for `agentpush`, the channel/phone. For `telegram`, the chat id.
- `contact_ref` — recipient id (`agentpush` contact_ref) or chat id (`telegram`).
- `bind` defaults to `true` — on a successful send, upserts a binding
  `(alias, source, contact_ref) -> sessionId` with `mode: "route-or-spawn"` and
  the chosen `provider`. Pass `bind: false` to send without binding.
- Returns `{ sent: boolean, bound: boolean }`. A send failure (`sent:
  false`) never binds.

### Provider-specific behaviour

**agentpush** calls the real `send_message` MCP tool on the imported alias:
```json
{
  "to": { "channel": "<source>", "address": "<contact_ref>" },
  "content": { "text": "<text>" }
}
```

**telegram** POSTs directly to the Telegram Bot API:
```
POST https://api.telegram.org/bot<token>/sendMessage
{ "chat_id": "<source>", "text": "<text>" }
```
The bot token is resolved from a `TelegramBotCredsStore` (configured
separately via `telegram_bot_token_set`).

### Telegram bot wiring recipe

1. Create the bot with @BotFather and copy the token.
2. Store the token in the daemon's credential store:
   ```json
   { "tool": "telegram_bot_token_set", "arguments": { "token": "..." } }
   ```
3. Create a provider-agnostic inbound endpoint:
   ```json
   {
     "tool": "inbound_endpoint_create",
     "arguments": {
       "slug": "telegram-agentproto",
       "provider": "telegram",
       "alias": "default",
       "mode": "route-or-spawn"
     }
   }
   ```
   The response includes the endpoint `secret`.
4. Start the narrow public ingress proxy (see below) and get its public URL.
5. Point Telegram's webhook at the proxy:
   ```json
   {
     "tool": "telegram_bot_set_webhook",
     "arguments": {
       "url": "https://<proxy-public-url>/inbound/telegram-agentproto",
       "secret_token": "<endpoint-secret>"
     }
   }
   ```

## Inbound routing modes

Both the poll watcher (`inbound-watcher.ts`, `inbound_watcher_start`'s
`mode` field) and `POST /inbound` share one decision function,
`routeInboundMessage` (`inbound-router.ts`):

| mode | binding exists, session alive | binding exists, session dead | no binding |
|---|---|---|---|
| `spawn` (poll watcher default) | *(ignored)* spawns a fresh agent | *(ignored)* spawns a fresh agent | spawns a fresh agent |
| `route` | routes into it (`"routed"`) | resurrects it, then routes (`"restarted-routed"`) | skips (`"skipped"`) |
| `route-or-spawn` (`POST /inbound` default) | routes into it (`"routed"`) | resurrects it, then routes (`"restarted-routed"`) | spawns a fresh agent if a spawn path is configured, else skips |

"Resurrects" means: an agent-cli session that's no longer alive is
restarted in place (same primitive `cron-scheduler.ts`'s `prompt-session`
job uses — `restartAgentSession(..., { forceAgentResume: true })`), and the
reply is delivered to the (possibly new) resulting session id. A session
counts as alive unless it's missing entirely or its `processAlive` field
is explicitly `false` — a pid-less ACP-native/remote session (no OS
process to probe) is treated as alive, not dead.

Every successful route into a bound session refreshes that binding's
`lastSeenTs`.

## `POST /inbound` — push ingress contract

Bearer-gated exactly like the mutating `/sessions/*` routes (read the
token from `<workspace>/.agentproto/runtime.json`):

```
POST /inbound
Authorization: Bearer <token>
Content-Type: application/json

{
  "alias": "agentpush",
  "source": "+33600000000",
  "contact_ref": "alice",
  "text": "sounds good, ship it",
  "messages": [ /* optional: raw agentpush events, for the spawn-fallback template */ ],
  "mode": "route-or-spawn"        // optional, default "route-or-spawn"
}
```

Responses:

- `200 { "action": "routed" | "spawned" | "restarted-routed" | "skipped", "sessionId"?: string }`
- `400` — a required field (`alias`/`source`/`contact_ref`/`text`) is
  missing, or `mode` isn't one of the three valid values.
- `401` — missing/invalid bearer token.
- `501` — the daemon wasn't wired with a `routeInboundMessage` handler
  (i.e. `POST /inbound` isn't enabled on this host).

Note: the daemon's own wiring never sets a `spawnForContact` for this
route — an unauthenticated webhook payload carries no adapter/prompt
template to spawn an agent with, so an unbound contact under
`route-or-spawn` is `"skipped"` rather than spawning an arbitrary agent
from push input. Only the poll watcher (which already has an
`adapter`/`promptTemplate` configured via `inbound_watcher_start`) spawns.

## Simulating an inbound message

### 1. The sim script (no live daemon needed)

`packages/runtime/scripts/simulate-inbound.mjs` composes the real wiring
in-process — real `SessionsRegistry`, real `TransmitterBindingStore`, real
`routeInboundMessage`, real `startHttpServer` — with one fake session
double standing in for a real adapter, so you can see the whole path
(HTTP → routing → the session actually receiving the turn) without an
agentpush server, an adapter install, or a running daemon:

```sh
pnpm --filter @agentproto/runtime sim:inbound
# or with overrides:
pnpm --filter @agentproto/runtime sim:inbound -- --contact=bob --text="ping from bob"
```

Flags (or matching env vars `ALIAS`/`SOURCE`/`CONTACT`/`TEXT`/
`SESSION_ID`/`PORT`/`TOKEN`): `--alias`, `--source`, `--contact`, `--text`,
`--session-id`, `--port`, `--token`. It prints the HTTP status, the
`{action, sessionId}` response, and the exact text the bound session
received, then exits non-zero if either doesn't match expectations.

### 2. `curl` against a live daemon

Bind a contact first (via `transmit_message`, or by hand-seeding
`~/.agentproto/transmitter-bindings.json`), then:

```sh
TOKEN=$(jq -r .token <workspace>/.agentproto/runtime.json)

curl -sS -X POST "http://127.0.0.1:<port>/inbound" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "agentpush",
    "source": "+33600000000",
    "contact_ref": "alice",
    "text": "sounds good, ship it"
  }'
```

A `200` with `{"action":"routed","sessionId":"..."}` means the reply
landed as a user turn in that session — check it with `agent_output` /
`GET /sessions/:id/stream`.

## Provider-agnostic inbound endpoints (`POST /inbound/:slug`)

As an alternative to the single shared bearer-gated `POST /inbound`, the
daemon now supports per-provider webhook endpoints:

```
POST /inbound/<slug>
```

Each endpoint is configured with dialect (`agentpush`, `telegram`,
`whatsapp`, `slack`, `generic`, `native`), an imported MCP alias, an
optional forced source, an optional webhook signing secret, and a routing
mode. The MCP tools `inbound_endpoint_create`, `inbound_endpoint_list`,
and `inbound_endpoint_delete` manage them. All endpoints are created via
`createInboundEndpointStore()` in `createGateway()` and share the same
`routeInboundMessage` router as the poll watcher and the legacy push route.

### Signature verification

When a secret is configured, the secret is REQUIRED and the bearer gate
is bypassed, so a publicly exposed webhook endpoint is not accidentally
opened by the loopback Origin allowlist.

| provider | header | algorithm/format |
|---|---|---|
| `agentpush` | `X-Agentpush-Signature` | `sha256=<hex-hmac-sha256>` |
| `telegram` | `X-Telegram-Bot-Api-Secret-Token` | exact secret, constant-time compare |
| `whatsapp` | `X-Hub-Signature-256` | `sha256=<hex-hmac-sha256>` |
| `slack` | `X-Slack-Signature` | Slack request signature v0 with replay window |
| `generic` | `X-Agentproto-Signature` | `sha256=<hex-hmac-sha256>` |
| `native` | n/a | uses the sessions bearer gate |

### Normalized envelope

After verification, the webhook JSON is normalized by `normalizeInbound()"
(`inbound-adapters.ts`) into the same `InboundMessage` shape the rest of
the transmitter expects:

```json
{
  "alias": "<configured alias>",
  "source": "<channel/phone/chat id>",
  "contactRef": "<sender id>",
  "text": "<message text>",
  "messages": [ /* optional: raw provider event */ ]
}
```

Provider-specific behaviour:

- `agentpush` and `slack` support a `challenge` handshake; the challenge is
  echoed as `{ "challenge": "..." }` and no session is touched.
- `telegram` and `slack` ignore bot/self messages.
- Missing text returns `200 { "action": "ignored", "reason": "no_text" }` so
  webhook providers do not retry forever.

### Deduplication

Each endpoint keeps an in-memory FIFO of the last ~500 seen provider
message ids via `markSeen()`. A duplicate returns `200 { "action":
"duplicate" }`.

### MCP tools

```json
{
  "tool": "inbound_endpoint_create",
  "arguments": {
    "slug": "telegram-bot",
    "provider": "telegram",
    "alias": "agentpush",
    "source": "@mybot",
    "mode": "route-or-spawn",
    "secret": "<optional>"
  }
}
```

`inbound_endpoint_list` returns endpoints without exposing the secret.
`inbound_endpoint_delete` removes by slug.

## Follow-up: agentpush-side wiring (not covered by this repo)

This repo only adds the ingress endpoint. For the push path to actually
fire in production, agentpush itself needs to be configured to `POST` a
webhook payload to `<daemon-url>/inbound` (with the daemon's bearer
token) whenever it receives an inbound message, instead of relying solely
on `inbound_watcher_start`'s 5-second poll loop.
