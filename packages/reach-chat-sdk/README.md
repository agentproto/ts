# @agentproto/reach-chat-sdk

The `chat-sdk` REACH adapter kind: reaches a human through a [Chat SDK](https://github.com/vercel/chat)
messenger adapter. First platform: WhatsApp Cloud API, `tell` only, outbound only.

Optional for `@agentproto/runtime`: the daemon imports it only when `reach.routes.<principal>` has a
`chat-sdk` entry. Without the package, such an entry is skipped `chat-sdk-not-installed` and the rest of
the route runs as before.

## Route entry

```json
{
  "id": "wa",
  "kind": "chat-sdk",
  "platform": "whatsapp",
  "to": "33600000000",
  "whatsapp": { "phoneNumberId": "100000000000001", "accessToken": "..." },
  "timeoutMs": 10000
}
```

- `to`: the recipient's WhatsApp id, E.164 digits without `+`.
- `whatsapp.phoneNumberId`: the Cloud API phone number id (not the number itself).
- `whatsapp.accessToken`: a secret. `config_get` shows `{ set: true }`, never the value.
- `timeoutMs`: default 10000.

The Chat SDK WhatsApp adapter demands an `appSecret` and a `verifyToken` even outbound only. No webhook
is served here, so both are random per instance and never configured. The Graph base URL, the bot name
and the logger are passed explicitly: no `WHATSAPP_*` environment variable is read.

## Behaviour

- `tell`: one text message, the summary then each link on its own line (`label: url`), cut at 4096
  characters, no buttons.
- `ask`: `undelivered(ask-not-supported)`, no request. The route goes on to its next adapter (the floor).
  A route made only of `chat-sdk` entries cannot acknowledge an approval, so the runtime does not start
  the router for it.

| Outcome | Receipt |
|---------|---------|
| Post resolved | `delivered` |
| Same `dedupeKey` already delivered by this instance | `deduped` (no request) |
| Meta error 131047, outside the 24 h customer service window | `undelivered(outside-24h-window)` |
| A throw once the post started (Meta 5xx, transport error) | `failed(maybe-sent)` |
| A throw before the post (building or initializing the bot) | `failed(send-failed)` |
| No answer within `timeoutMs` | `failed(timeout)` |

No receipt and no log line carries the token, the phone number id, the recipient or Meta's error text.
Templates (for messages outside the 24 h window), buttons and inbound taps are not built.

## Capabilities

`maxChars` 4096, `actions` 0, `files` false, `link` true, `defers` false, `retracts` false, `identity`
false.

## Chat SDK rules followed

Measured in a spike against `chat@4.44.0`: the bot is initialized once with `createMemoryState()` before
the first post (without state, `post` throws after the message went out), and the recipient is addressed
with `adapter.openDM(to)` then `bot.thread(id)`, never `bot.openDM` (it rejects a WhatsApp id).

`chat`, `@chat-adapter/whatsapp` and `@chat-adapter/state-memory` are pinned to the same exact version.
