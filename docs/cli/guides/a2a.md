# Call an app's agents over A2A

Any agent app installed on your daemon can be called by another machine or
another agent framework through the [A2A 1.0](https://a2a-protocol.org)
protocol: the caller reads an Agent Card, sends a message, and reads the agent's
answer back from a task. This guide exposes an app, reaches it from outside
through a private tunnel, and runs a full `SendMessage` → `GetTask` round trip.

Requires a running daemon ([`serve`](../verbs/serve.md) /
[`daemon`](../verbs/daemon.md)) and an installed app
([Install apps](install-apps.md)).

## 1. Declare what the app exposes

Only apps that opt in get a task endpoint. In the app's `APP.md`, list the
agents callers may run under `exposes.agents` and set `accepts.tasks: true`:

```yaml
---
schema: app/v1
id: '@acme/echo'
name: Echo
version: 0.1.0
description: Repeats your message in uppercase.
agents:
  - id: echo
    path: .agentproto/agents/echo/AGENT.md
exposes:
  agents:
    - echo
accepts:
  tasks: true
---
```

Each exposed agent becomes one **skill** on the app's Agent Card, and its id is
the skill id a caller asks for. Only agent skills can run as tasks today: a
workflow listed under `exposes.workflows` shows on the card, but `SendMessage`
on it returns `unsupported operation`.

The agent runs on the adapter it would get anywhere else: `metadata.adapter`
(or `metadata.harness`) in its `AGENT.md` first, then the default for its
model (`claude-*` models run on `claude-code`), then `mastra-agent`:

```yaml
---
schema: agent/v1
id: echo
description: Replies with the user's message in uppercase.
model: claude-haiku-5-5
metadata:
  adapter: claude-code
---

Reply with exactly one line: the user's message in uppercase. Do not use any tool.
```

Install (or re-install) the app so the daemon picks up the manifest:

```bash
agentproto app install ./echo-app
```

## 2. The routes

```
GET  /.well-known/agent-card.json                    daemon index card
GET  /a2a/apps/:appId/.well-known/agent-card.json    one card per app
POST /a2a/apps/:appId                                A2A 1.0 JSON-RPC 2.0 task ingress
```

`:appId` is URL-encoded, so `@acme/echo` is `%40acme%2Fecho`. The card's
`supportedInterfaces[0].url` is the URL a client should POST to.

All three routes take the daemon bearer (`daemon.authToken` in
`~/.agentproto/config.json`, see the
[config reference](../reference/config-schema.md)) as
`Authorization: Bearer <token>` (when no token is configured they are open;
local callers that did not come through a proxy are always exempt), and refuse
browser cross-origin calls.

## 3. Reach the daemon from another machine

The daemon listens on `127.0.0.1:18790` only. Open a private tunnel to it:

```bash
agentproto tunnel create --port 18790 --ttl 24h
```

(or the `tunnel_create` MCP tool with `targetPort: 18790`). It returns a
`publicUrl` and a `url` carrying a signed `?t=` token. The tunnel's access
guard refuses every request without that token. A client exchanges it once:

1. `GET <publicUrl>/?t=<token>` answers `303` with a
   `Set-Cookie: __Host-ap_tunnel=…` header.
2. Send that cookie on every following request, **plus** the daemon bearer.

The guard forwards the public host to the daemon as `X-Forwarded-Host`, so the
Agent Card fetched through the tunnel advertises the tunnel's `https://` URL,
not `127.0.0.1`. If the daemon sits behind your own reverse proxy instead, set
`AGENTPROTO_PUBLIC_HTTP_ORIGIN` to its public origin; that setting always wins.

`tunnel_revoke` invalidates the link at once; `tunnel_stop` tears the tunnel
down.

## 4. Send a task

Pick the skill with `message.metadata.skill` (or start the first text part
with `skill:<id>`; the rest of that part becomes the prompt):

```bash
curl -s "$BASE/a2a/apps/%40acme%2Fecho" \
  -H "Cookie: $COOKIE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "A2A-Version: 1.0" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
    "params": { "message": {
      "messageId": "m-1", "role": "ROLE_USER",
      "metadata": { "skill": "echo" },
      "parts": [{ "text": "hello from the other machine" }]
    } }
  }'
```

The daemon starts an `app_run` of that one agent and returns the task right
away, usually still working:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "task": {
  "id": "apprun_4bce4025-…",
  "contextId": "4a73596e-…",
  "status": { "state": "TASK_STATE_WORKING", "timestamp": "…" },
  "metadata": { "appId": "@acme/echo", "skill": "echo" }
} } }
```

The task id is the app run id, so the `app_status` MCP tool shows the same run
on the daemon side.

## 5. Read the answer

Poll `GetTask` with the task id:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "GetTask", "params": { "id": "apprun_4bce4025-…" } }
```

The task is `TASK_STATE_COMPLETED` as soon as every agent of the run has
finished its turn (the agent session itself stays open and idle, so the run is
not over yet, but the task is). The answer then comes back twice:

- `status.message`: a `ROLE_AGENT` message whose text is the agent's last
  reply.
- `artifacts`: one `agent-output-<agentId>` text artifact per agent, followed
  by the app's own HTML artifact if the app declares one.

```json
{ "status": {
    "state": "TASK_STATE_COMPLETED",
    "message": { "role": "ROLE_AGENT", "parts": [{ "text": "HELLO FROM THE OTHER MACHINE" }] }
  },
  "artifacts": [
    { "artifactId": "agent-output-echo", "name": "echo", "parts": [{ "text": "HELLO FROM THE OTHER MACHINE" }] }
  ] }
```

The reply is read from the session transcript, falling back to the session's
outcome summary. Other states: `TASK_STATE_FAILED` when the run errors,
`TASK_STATE_CANCELED` after a cancel.

To stop a task that is still working:

```json
{ "jsonrpc": "2.0", "id": 3, "method": "CancelTask", "params": { "id": "apprun_4bce4025-…" } }
```

This stops the app run and kills its sessions. Cancelling a task that already
reached a final state returns `task not cancelable`.

## What is not supported yet

- `SendStreamingMessage`, `SubscribeToTask` and `ListTasks` return
  `unsupported operation`: poll `GetTask` instead.
- Push notifications and the extended Agent Card are not configured.
- Workflow skills cannot run as tasks (see step 1).
- Only A2A version `1.0` is accepted (`A2A-Version` header or `?version=`
  query); anything else returns `version not supported`.
- The task is complete when the agent's turn ends, not when it decides the job
  is done. An agent that ends a turn with a failure, without its session
  dying, still reports `COMPLETED`: read the answer text.

## Troubleshooting

| Error | Cause |
| --- | --- |
| `no skill requested` | Set `message.metadata.skill` or prefix the first text part with `skill:<id>`. |
| `unknown skill "…"` | The id is not in the app's `exposes.agents`. |
| `its manifest does not declare accepts.tasks: true` | Add `accepts.tasks: true` and re-install the app. |
| `could not read app manifest` | The app's install directory moved or was deleted: re-install it from its new place. |
| `agent "…" did not start` | The agent's adapter could not spawn: check its model and `metadata.adapter`, and that the adapter is installed and logged in (`agentproto adapters list`). |
| `403` from the tunnel | The `__Host-ap_tunnel` cookie is missing or the link was revoked or expired. |
| `401` from the daemon | Missing or wrong `Authorization: Bearer`. |
| Card URL shows `127.0.0.1` | You reached the daemon without the tunnel guard or a proxy that sets `X-Forwarded-Host`; set `AGENTPROTO_PUBLIC_HTTP_ORIGIN`. |
