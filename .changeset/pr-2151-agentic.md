---
"@agentproto/runtime": minor
---

Add the AIP-68 clerk turn-end hook: a debounced, single-flight, fire-and-forget daemon subscriber that runs one clerk pass after a session's turn ends, a three-level (daemon/workspace/agent) configuration resolver, and a routine/command pass runner, wired into `createGateway`. Adds the `agent_start.hooks` field and records the agent-level config on the session descriptor.
