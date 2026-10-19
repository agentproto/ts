---
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": patch
"@agentproto/cli": patch
"@agentproto/adapter-opencode": patch
---

Add `capabilities.deferredToolDiscovery` and wire it through the adapter resolver: a harness that cannot call a tool omitted from its last `tools/list` (opencode rejects it client-side) now gets the daemon self-mount eager, so `daemonMount` no longer hides `branch_gc_verdict` and other tools behind a `tool_search` the model cannot use.
