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
the skill id a caller asks for. The same goes for a workflow listed under
`exposes.workflows` — see [Call a workflow skill](#call-a-workflow-skill).

The agent runs on the adapter it would get anywhere else: `metadata.adapter`
(or `metadata.harness`) in its `AGENT.md` first, then the default for its
model (`claude-*` models run on `claude-code`, `opencode/*` and
`opencode-go/*` models on `opencode`). There is no fallback: an agent with
neither fails with `agent "…" has no adapter`, so add
`metadata: { adapter: mastra-agent }` to run it on `mastra-agent`:

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

## Call a workflow skill

An exposed workflow whose id also appears in the app's bundled `workflows`
(its `WORKFLOW.md`) runs as a task too. Send `SendMessage` with that skill id:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
  "params": { "message": {
    "messageId": "m-2", "role": "ROLE_USER",
    "metadata": { "skill": "nightly-report" },
    "parts": [{ "text": "compile the October report" }]
  } } }
```

The daemon starts the bundled workflow in the background through the same
runner as `workflow_run_file` and answers with a task whose id **is the
workflow run id** (poll it with `workflow_status` on the daemon side too).
Two rules decide what the workflow sees as `$input`:

1. The first `data` part on the message, when its value is an object, is
   passed through as the input as is.
2. Otherwise the prompt text becomes `{ "prompt": "…" }`; with neither, the
   input is `{}`.

An exposed workflow that the app does not bundle fails with
`unsupported operation`. `CancelTask` on a running workflow task cancels the
run (`workflow_cancel`) instead of stopping an app run.

A workflow task's state maps from the run's status like this:

| `workflow_status` | A2A task state |
| --- | --- |
| `running`, `idle` | `TASK_STATE_WORKING` |
| `awaiting-input`, `awaiting-approval` | `TASK_STATE_INPUT_REQUIRED` |
| `done` | `TASK_STATE_COMPLETED` |
| `failed` | `TASK_STATE_FAILED` |
| `cancelled` | `TASK_STATE_CANCELED` |

A `done` run answers with one artifact named `output` — a `data` part when the
workflow's output is an object, a `text` part (`String(output)`) otherwise. A
`failed` run puts the run's error in `status.message` as a `ROLE_AGENT`
message and carries no artifacts.

## List tasks

`ListTasks` pages through every task the endpoint created for the app, newest
first. All params are optional:

| Param | Meaning |
| --- | --- |
| `contextId` | Only tasks of that context. |
| `status` | Only tasks in that `TASK_STATE_*`. |
| `pageSize` | 1–100, default 50. Outside that range is `invalid params`. |
| `pageToken` | Opaque token from a previous reply's `nextPageToken`. |
| `historyLength` | `0` drops each task's `history`; `n > 0` keeps its last `n` messages. |
| `statusTimestampAfter` | Only tasks whose status timestamp is after this ISO timestamp. |
| `includeArtifacts` | `true` keeps each task's `artifacts`; the default drops them. |

```json
{ "jsonrpc": "2.0", "id": 4, "method": "ListTasks",
  "params": { "pageSize": 2, "status": "TASK_STATE_COMPLETED" } }
```

The result is `{ tasks, nextPageToken, pageSize, totalSize }`; tasks are
ordered newest first (by ledger creation, ties broken by write order), and
`nextPageToken` is `""` on the last page. Feeding a token back with the same
filters yields the next page; `totalSize` is the number of matching tasks.

With a `status` or `statusTimestampAfter` filter the daemon has to read each
candidate task, so only the **500 newest** ledger entries are considered for
the match. A ledger entry whose backing run is gone is skipped rather than
failing the call.

## Streaming

Two methods stream a task as server-sent events instead of making you poll
`GetTask`. Both answer `Content-Type: text/event-stream`, and each event is
`data:` followed by one whole JSON-RPC response — the request's `id`, and a
`result` that is exactly one of:

- `{ "task": … }` — the task as it stands when the stream opens.
- `{ "statusUpdate": { "taskId", "contextId", "status", "final"? } }` — a new
  state, or a new timestamp on the same state. `final: true` marks the last
  one.
- `{ "artifactUpdate": { "taskId", "contextId", "artifact", "lastChunk"? } }` —
  one artifact, sent once, ahead of the status update that reports the task
  terminal.

`SendStreamingMessage` takes exactly what `SendMessage` takes — it starts the
run, then streams it:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "SendStreamingMessage",
  "params": { "message": {
    "messageId": "m-3", "role": "ROLE_USER",
    "metadata": { "skill": "echo" },
    "parts": [{ "text": "hello" }]
  } } }
```

`SubscribeToTask` attaches to a task that is already running:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "SubscribeToTask",
  "params": { "id": "apprun_4bce4025-…" } }
```

The daemon polls the run every second and writes a `: keepalive` comment every
15 s while the stream is otherwise silent. A stream ends when the task reaches
a terminal state (its last event is then the `statusUpdate` with
`final: true`), when the client disconnects, or after 30 minutes — the cap
closes with a `statusUpdate` carrying the state the task is actually in, not a
`final` claim. Everything knowable before the stream opens stays a plain
JSON-RPC error response instead of a stream: a bad request, an unknown task
id, and `SubscribeToTask` on a task that already finished
(`task is already TASK_STATE_COMPLETED` — read a finished task with `GetTask`).

## Push notifications

Instead of polling or streaming, a caller can register a webhook URL and have
the daemon POST every task update to it. The Agent Card advertises
`capabilities.pushNotifications: true`. Four methods manage the registrations
for one task — each config carries its own `id`:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "CreateTaskPushNotificationConfig",
  "params": { "taskId": "apprun_4bce4025-…",
    "url": "https://client.example.com/webhook/a2a",
    "token": "a-token-unique-for-this-task",
    "authentication": { "scheme": "Bearer", "credentials": "my-secret" } } }
```

Only `taskId` and `url` are required (`id` may be supplied, else one is
assigned; a create with an existing `id` replaces that config). A task keeps
at most **10** configs — an 11th is `invalid params`. The URL rules: `https:`
only, except `http:` to `localhost` / `127.0.0.1` / `::1` for local testing,
and never a URL with `user:password@` userinfo — anything else is
`invalid params`. Any `https:` host is accepted, because the caller is the
authenticated owner of the webhook: only register URLs you control. The task
must exist (a task unknown to the endpoint is `task not found`), and so must
a config you `Get`/`Delete`:

```json
{ "method": "GetTaskPushNotificationConfig",  "params": { "taskId": "…", "id": "…" } }
{ "method": "ListTaskPushNotificationConfigs", "params": { "taskId": "…" } }
{ "method": "DeleteTaskPushNotificationConfig", "params": { "taskId": "…", "id": "…" } }
```

`SendMessage` / `SendStreamingMessage` can carry the same object in one shot
as `configuration.taskPushNotificationConfig` (alias:
`configuration.pushNotificationConfig`); it is validated before the run
starts, so a bad URL starts nothing.

While the task runs, every update the SSE streams would emit is POSTed to
each config of the task — one JSON body per event, a `StreamResponse`
oneof member exactly as in [Streaming](#streaming):

```json
{ "statusUpdate": { "taskId": "…", "contextId": "…",
    "status": { "state": "TASK_STATE_COMPLETED", "timestamp": "…" },
    "final": true } }
```

Delivery details:

- Headers: `Content-Type: application/json`, `X-A2A-Notification-Token:
  <token>` when the config carries a `token`, and
  `Authorization: <scheme> <credentials>` when its `authentication` carries
  credentials.
- Per POST: a 10 s timeout, up to 3 attempts with 1 s / 5 s backoff. A 2xx
  acknowledges; a 4xx (other than 408/429) is not retried. Failures are
  logged and never stop delivery of later events.
- One background watcher per task (not per config); each event is delivered
  to every current config in parallel (a slow webhook does not delay the
  others), and a deleted config stops receiving at once. The watcher ends
  after delivering the terminal event (`final: true`) or at the same
  30-minute cap as streaming.
- A config created on a task that is already terminal gets exactly one final
  `statusUpdate` (`final: true`) — delivered to that config only, not to the
  task's other configs — and no watcher. The delivery runs in the background:
  the JSON-RPC answer does not wait on the webhook.
- **Watchers live in memory only**: after a daemon restart, pending tasks
  are not resumed. Their configs persist on disk — re-create a config (or
  send a new message with one) to start watching again.

## What is not supported yet

- The extended Agent Card is not configured (`GetExtendedAgentCard` answers
  `extended agent card not configured`).
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
