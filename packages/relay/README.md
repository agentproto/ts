# @agentproto/relay

A small, standalone companion service that lets **one** external HTTP webhook
wake up **one** specific, pre-configured agentproto daemon session.

This is generic OSS infrastructure. It has no knowledge of, and no code
specific to, any particular external product, CRM, or messaging platform.
Wiring this up to a specific external system (mapping that system's webhook
payload into `{"text": "..."}`, handling its signature scheme, etc.) is
integration work that happens outside this package — this package only knows
how to accept `{"text": "..."}` and forward it to a daemon session.

## Security model — read this before exposing it publicly

This service is designed to run behind a public tunnel. The main risk of
"webhook wakes up an agent" is a leaked or guessed credential letting an
attacker inject prompts into *any* of your live sessions. This package's
answer to that:

- **Exactly one target session, fixed at startup.** The session id/name is
  read once from `AGENTPROTO_RELAY_TARGET_SESSION` at process start. It is
  **never** accepted as part of an inbound request — there is no `sessionId`
  field anywhere in the `/relay/inbound` API. Even a fully leaked bearer
  token only lets a caller wake up the one session the operator explicitly
  chose to expose.
- **Mandatory bearer token, constant-time compare.** `AGENTPROTO_RELAY_TOKEN`
  is required — the process refuses to start without it. There is no
  no-auth fallback, ever. The comparison uses an HMAC-blinded constant-time
  compare (not `===`, not a naive `timingSafeEqual` on raw buffers) so a
  network attacker can't use response-timing differences to recover the
  token one byte at a time.
- **Basic rate limiting.** A publicly reachable endpoint that triggers an LLM
  turn is a real cost/abuse vector even behind a valid-looking token. See
  below for the default and how to tune it.
- **Inbound-only.** This service relays *into* a session. Getting output back
  out is the target session's own job, using whatever tools/credentials it's
  separately given — that's intentionally not this package's concern.

## What it exposes

### `POST /relay/inbound`

Body is a flexible JSON object. The **only** field read is a top-level
`text` string — everything else is ignored. This is deliberate: it makes the
endpoint compatible with webhook payloads from arbitrary external senders
(which typically include a `text`/`message`/`body` field buried among sender
metadata this package has no reason to understand) without needing per-sender
adapter code.

Requires `Authorization: Bearer <AGENTPROTO_RELAY_TOKEN>`.

On a valid, authenticated request:

1. Confirms the configured target session exists and is alive via the
   daemon's `GET /sessions/:id`.
2. Delivers `text` to it via the configured delivery mode — either
   `agent_prompt` (`POST /sessions/:id/prompt`, fire-and-forget) or
   `terminal_input` (a WebSocket write to a PTY session's stdin).
3. Returns `202 { ok: true, sessionId, via }` once the daemon has accepted
   the message. This does **not** wait for the agent to finish its turn —
   webhook senders often have short timeouts, and there's no reason to hold
   the connection open for an entire LLM turn just to relay one message in.

Error responses are plain JSON with an `error` code and a human-readable
`message`: `401 unauthorized`, `429 rate_limited`, `400 missing_text` /
`invalid_body`, `502 target_session_unavailable` / `relay_delivery_failed`.

### `GET /relay/health`

Trivial healthcheck. No auth required.

## Configuration

All via environment variables:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `AGENTPROTO_RELAY_TARGET_SESSION` | yes | — | The id or name of the ONE session this relay may wake up. |
| `AGENTPROTO_RELAY_TOKEN` | yes | — | Shared-secret bearer token for `/relay/inbound`. The process refuses to start if this is unset or empty. |
| `AGENTPROTO_RELAY_TARGET_VIA` | no | `agent` | `agent` (deliver via `agent_prompt`) or `terminal` (deliver via `terminal_input`). |
| `AGENTPROTO_DAEMON_URL` | no | `http://127.0.0.1:18790` | Base URL of the agentproto daemon to talk to. |
| `AGENTPROTO_RELAY_RATE_LIMIT` | no | `20` | Max `/relay/inbound` requests allowed per rate-limit window. |
| `AGENTPROTO_RELAY_RATE_WINDOW_MS` | no | `60000` | Rate-limit window size, in milliseconds. |

The rate limit is **global**, not per-caller — this relay is designed for
exactly one legitimate caller (whoever holds the token), so there's no
per-IP bucketing to bypass or exhaust via header spoofing.

## Running it

```bash
# from the monorepo root, after `pnpm install` + `pnpm build`
AGENTPROTO_RELAY_TARGET_SESSION=my-session \
AGENTPROTO_RELAY_TOKEN=$(openssl rand -hex 32) \
node packages/relay/dist/cli.mjs --port 8790
```

Add `--tunnel` to also ask the daemon (via its `tunnel_create`/`/tunnels`
REST route) to spawn a public cloudflared quick tunnel for `--port`, and
print the resulting public URL:

```bash
AGENTPROTO_RELAY_TARGET_SESSION=my-session \
AGENTPROTO_RELAY_TOKEN=$(openssl rand -hex 32) \
node packages/relay/dist/cli.mjs --port 8790 --tunnel
```

```
Public relay URL — paste this into whatever external system sends the webhook:
  https://random-words-1234.trycloudflare.com/relay/inbound
```

That printed URL — `<tunnel-url>/relay/inbound` — is what you paste into
whatever external system delivers the webhook. Without `--tunnel`, the relay
just binds to `127.0.0.1:<port>` for local testing.

## curl example

```bash
curl -X POST http://127.0.0.1:8790/relay/inbound \
  -H "Authorization: Bearer $AGENTPROTO_RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "a customer just replied, take a look"}'
```

```json
{"ok":true,"sessionId":"sess_abc12345","via":"agent"}
```

## Explicitly out of scope

- Any specific external integration — mapping a particular product's webhook
  shape into `{"text": "..."}`, verifying that product's signature scheme,
  etc. That's integration-specific glue that lives outside this repo.
- Outbound delivery. This is inbound-only: external webhook → wake a
  session. Sending messages back out is the target session's own job.
- Multi-session or dynamic target selection. Deliberately not supported —
  see the security model above.
