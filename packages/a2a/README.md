# @agentproto/a2a

Typed [A2A (Agent2Agent)](https://a2a-protocol.org) Agent Card and builders for
agentproto apps. The types are written by hand from the A2A 1.0 definition
(`specification/a2a.proto`, ProtoJSON; `A2A_PROTOCOL_VERSION` is `"1.0"`); there is
no SDK dependency.

```ts
import { buildAppAgentCard, buildDaemonAgentCard } from "@agentproto/a2a"

const card = buildAppAgentCard({
  appId: "@acme/notes",
  name: "Notes",
  baseUrl: "http://127.0.0.1:4711",
  exposes: { agents: ["summarizer"], workflows: [] },
  agents: [{ id: "summarizer", description: "Summarizes a note." }],
  accepts: { tasks: true },
})
```

- One card per app, served at `/a2a/apps/<appId>/.well-known/agent-card.json`
  with `supportedInterfaces[0] = { url: <baseUrl>/a2a/apps/<appId>, protocolBinding:
  "JSONRPC", protocolVersion: "1.0" }` (the appId is URL-encoded).
- Skills come only from `exposes`; an app that exposes nothing has `skills: []`.
- `capabilities.streaming` and `pushNotifications` are `false`; auth is an HTTP
  bearer scheme (`securitySchemes.bearer.httpAuthSecurityScheme`, required via
  `securityRequirements`).
