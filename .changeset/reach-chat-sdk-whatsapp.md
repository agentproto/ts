---
"@agentproto/reach-chat-sdk": minor
"@agentproto/reach": minor
"@agentproto/runtime": minor
---

New REACH adapter kind `chat-sdk`, in the new optional package `@agentproto/reach-chat-sdk` (Chat SDK `chat`, `@chat-adapter/whatsapp` and `@chat-adapter/state-memory`, all pinned to 4.44.0). First platform: WhatsApp Cloud API, `tell` only, outbound only. A route entry `{ id, kind: "chat-sdk", platform: "whatsapp", to, whatsapp: { phoneNumberId, accessToken }, timeoutMs? }` posts one text (the summary, then each link on its own line, capped at 4096 characters) and answers `delivered`, `deduped`, `undelivered(outside-24h-window)` on Meta error 131047, `failed(maybe-sent)` once the post started, `failed(send-failed)` before it, or `failed(timeout)` (default 10 s). An `ask` answers `undelivered(ask-not-supported)` with no request, so the route goes on to the floor. No token, phone number id, recipient or Meta error text is put in a receipt or a log line.

`@agentproto/reach` adds `ReachChatSdkRouteEntry` to the `ReachRouteEntry` union. `@agentproto/runtime` accepts the entry in `reach.routes.*`, redacts `whatsapp.accessToken` to `{ set: true }` in `config_get`, lists the package under `optionalDependencies` and imports it only when the owner route names a `chat-sdk` entry (otherwise such an entry is skipped `chat-sdk-not-installed`). A route made only of `chat-sdk` entries cannot acknowledge an approval, so it starts no router and the Telegram bridge keeps announcing on its own.
