---
name: ap-transmit
description: Send messages out and receive replies into agentproto sessions — transmit_message with contact binding, inbound_watcher_start to poll sources and spawn/route agents per inbound contact, inbound endpoints for POST /inbound/<slug> webhooks, and Telegram bot wiring. Trigger when asked to send outbound messages, wire a webhook, poll a chat source, or set up a Telegram bot.
---

# ap-transmit

## When to use

- You must push a message OUT (agentpush, Telegram, WhatsApp, Slack, generic webhook) and route the contact's future replies back into a live session.
- You want a poller that turns inbound messages into agent sessions automatically.
- A provider needs a signature-verified webhook endpoint (`POST /inbound/<slug>`).

## transmit_message: send + bind

```json
transmit_message({
  "provider": "agentpush",
  "alias": "agentpush",                    // imported MCP alias (agentpush) or bot alias (telegram)
  "source": "+33612345678",                // channel/phone the message goes out from
  "contact_ref": "+33698765432",           // recipient (agentpush sender id) / chat id (telegram)
  "sessionId": "sess_abc123",              // the session replies route into
  "text": "Deploy finished — see the report.",
  "bind": true                             // default: upsert contactRef→sessionId after send
})
```

**Always pass `sessionId`.** With binding (default), future inbound from that contact lands in the SAME session instead of spawning a fresh orphan agent. Attachments (photo/document/video/audio) take local absolute paths.

## inbound_watcher_start: poll a source for new messages

```json
inbound_watcher_start({
  "alias": "agentpush",                    // the imported MCP to poll through
  "source": "+33612345678",
  "adapter": "claude-code",                // what spawns when a message arrives
  "promptTemplate": "New message from {{contact_ref}} ({{count}}): {{messages_json}}\nReply with dispatch_request.",
  "mode": "route-or-spawn",                // bound contacts route into their session; unbound ones spawn fresh
  "pollIntervalMs": 5000
})
// → { "watcherId": "..." }  — stop with inbound_watcher_stop; inspect with inbound_watcher_list
```

Modes: `spawn` (always fresh agent — the default), `route` (bound contacts only, skips unbound), `route-or-spawn` (hybrid). Watcher cursors survive daemon restarts only if the watcher was stopped cleanly — after any restart, check `inbound_watcher_list` before starting a duplicate.

## inbound_endpoint_create: provider-agnostic webhooks

```json
inbound_endpoint_create({
  "slug": "stripe-events",                 // POST https://<daemon>/inbound/stripe-events
  "provider": "generic",                   // agentpush | telegram | whatsapp | slack | generic | native
  "alias": "agentpush",                    // routes the normalized payload into this MCP
  "mode": "route-or-spawn"
  // secret: omit to auto-generate; it is never echoed back
})
inbound_endpoint_list({})                  // endpoints, never secrets
inbound_endpoint_delete({ "slug": "stripe-events" })
```

POSTs are normalized from the provider's dialect and signature-verified when a secret is configured.

## Telegram bots

```json
telegram_bot_token_set({ "token": "123:ABC...", "alias": "default" })  // stored 0600, never returned
telegram_bot_token_status({ "alias": "default" })                       // fingerprint + last4 only
telegram_bot_set_webhook({ "alias": "default", "url": "https://example.com/tg" })
```

## Gotchas

- No `sessionId` on `transmit_message` ⇒ the contact's replies spawn **orphan agents** nobody supervises. Always bind, or set `bind: false` deliberately.
- Watcher cursor position is preserved across a clean stop and restored by a later watcher; a hard restart loses the in-memory position — re-check `inbound_watcher_list` and re-create with the same alias if gone.
- `inbound_endpoint_create` secrets are never echoed back — auto-generated ones are shown once at creation, same discipline as tunnel bearer tokens.
- Webhook URLs must be publicly reachable — pair with a tunnel (ap-tunnels) for local daemons; `telegram_bot_set_webhook` requires HTTPS.
- Prompt templates interpolate `{{source}}`, `{{contact_ref}}`, `{{messages_json}}`, `{{count}}` — missing braces silently pass through as literal text.

## Pointers

- agentproto — daemon overview; the ingress/egress surface.
- ap-tunnels — public HTTPS URL a webhook endpoint needs.
- ap-spawn-agent — what watcher mode `spawn` does per message.
- ap-lifecycle — routing unbound contacts safely; session revival for dead bind targets.
