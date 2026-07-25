# The agentpush ⇄ agentproto transmitter

Bidirectional bridge between an imported agentpush MCP server (Telegram,
etc.) and a live agentproto session: outbound sends can bind a contact to
the session that sent them, and inbound replies from that contact then
route straight into the SAME session — as a real user turn — instead of
spawning a brand-new agent every time.

## The model

A single `TransmitterBindingStore` (`transmitter-bindings.ts`) maps

```
(alias, source, contactRef) -> { sessionId, mode, lastSeenTs }
```

- `alias` — the imported agentpush MCP alias (e.g. `"agentpush"`).
- `source` — the channel/phone the message is scoped to (agentpush's
  `source` field, e.g. a phone number or webhook channel name).
- `contactRef` — the sender's id within that source (agentpush's
  `contact_ref`).
- `sessionId` — the agentproto session future inbound replies from this
  contact should route into.
- `mode` — the routing mode this binding was created under (`"route"` or
  `"route-or-spawn"`; see below).

One shared store instance is constructed in `index.ts` and injected into
three places: the inbound poll watcher, the `transmit_message` tool, and
the `POST /inbound` push route. Bindings persist (debounced JSON write) to
`~/.agentproto/transmitter-bindings.json`, load-on-construct, and start
empty on a missing/corrupt file rather than throwing.

## Outbound: `transmit_message`

MCP tool that sends a message out through an imported agentpush alias's
`dispatch_request` tool and, by default, binds the recipient to the
calling session:

```json
{
  "alias": "agentpush",
  "source": "+33600000000",
  "contact_ref": "alice",
  "text": "your PR is ready for review",
  "sessionId": "sess_abc123",
  "bind": true
}
```

- `bind` defaults to `true` — on a successful send, upserts a binding
  `(alias, source, contact_ref) -> sessionId` with `mode: "route-or-spawn"`.
  Pass `bind: false` to send without binding.
- Returns `{ sent: boolean, bound: boolean }`. A send failure (`sent:
  false`) never binds.

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

## Follow-up: agentpush-side wiring (not covered by this repo)

This repo only adds the ingress endpoint. For the push path to actually
fire in production, agentpush itself needs to be configured to `POST` a
webhook payload to `<daemon-url>/inbound` (with the daemon's bearer
token) whenever it receives an inbound message, instead of relying solely
on `inbound_watcher_start`'s 5-second poll loop.
