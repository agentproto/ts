# @agentproto/events-channel

A [Claude Code channel](https://code.claude.com/docs/en/channels) that makes a Claude Code session a subscriber of
agentproto MCP Events: the same role ChatGPT plays, with matching events pushed into the session as `<channel>`
notifications.

```
agentproto daemon --signed webhook (public https)--> events-channel --stdio notifications/claude/channel--> Claude Code
```

The channel does the subscriber side of MCP Events: it calls the daemon's `events/subscribe` with a callback URL and a
`whsec_` secret, answers the daemon's signed challenge, verifies the Standard Webhooks signature on every delivery,
drops duplicates by `eventId`, and refreshes each subscription before it expires.

## Use

Register it as an MCP server (project `.mcp.json`, or `~/.claude.json` with an absolute path):

```json
{
  "mcpServers": {
    "agentproto-events": {
      "command": "npx",
      "args": ["-y", "@agentproto/events-channel"],
      "env": {
        "AGENTPROTO_EVENTS_URL": "http://127.0.0.1:18790/mcp",
        "AGENTPROTO_EVENTS_TOKEN": "<daemon bearer token>"
      }
    }
  }
}
```

Channels are a research preview, and a custom channel is not on the approved allowlist, so start Claude Code with:

```bash
claude --dangerously-load-development-channels server:agentproto-events
```

Then ask Claude to list the events and subscribe, for example "subscribe to `github.pull_request.closed` for repo
`owner/name` number 12". It calls `events_list` and `events_subscribe`; when the PR closes the event arrives as:

```
<channel source="agentproto-events" event="github.pull_request.closed" event_id="evt_..." subscription_id="sub_...">
PR owner/name#12 closed
{"eventId":"evt_...","name":"github.pull_request.closed","data":{...}}
</channel>
```

Channels need claude.ai login (not Bedrock, Vertex or Foundry), and Team and Enterprise organizations must enable
them.

## Configuration

| Env | Meaning |
|---|---|
| `AGENTPROTO_EVENTS_URL` | Daemon MCP endpoint (default `http://127.0.0.1:18790/mcp`). |
| `AGENTPROTO_EVENTS_TOKEN` | Daemon bearer token. |
| `EVENTS_CALLBACK_BASE` | Public https origin that reaches the receiver (a named tunnel or reverse proxy). Unset: a `cloudflared` quick tunnel is started at launch. |
| `EVENTS_LISTEN_PORT` | Local receiver port (default: random). |
| `EVENTS_SUBSCRIBE` | JSON array of `{ name, arguments, ttlMs? }` to subscribe to at startup. |

The daemon only delivers to public https URLs, so the receiver needs one. The quick tunnel takes 1 to 2 minutes
before it routes, so it starts at launch rather than inside the first tool call. `cloudflared` is run with an empty
config: a global `~/.cloudflared/config.yml` that ends in a catch-all `http_status:404` otherwise hijacks it.

## Security

An open channel is a prompt-injection vector, so the receiver serves only an unguessable path and drops anything
without a valid Standard Webhooks signature (5 minute timestamp window) before it can reach the session. The daemon
bearer token never leaves the process. One-way: Claude acts on events but nothing is sent back to the webhook.

## API

`createEventsChannel({ daemon, publicBase, hookPath })` returns the MCP `server`, a transport-free `handleDelivery`,
and `subscribe` / `unsubscribe` / `close`. `startReceiver`, `createDaemonClient` and the tunnel helpers are exported
for embedding.
