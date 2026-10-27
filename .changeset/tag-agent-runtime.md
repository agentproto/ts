---
"@agentproto/agent-runtime": major
---

Emit the canonical AIP-70 `runtime/v1` schema tag for MultiAgentRuntime manifests instead of `agentruntimes/v1`. Breaking for readers: files written by this version need @agentproto/agent-runtime >= 0.2.0 to read. Readers of this version still accept `agentruntimes/v1`.
