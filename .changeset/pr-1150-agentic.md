---
"@agentproto/runtime": patch
---

Fix regression: stamp sandboxPorts on session descriptors. The SpawnAgentInput interface was missing the sandboxPorts field, causing the port-to-URL map from booted sandboxes to be silently dropped when building session descriptors. Now properly threaded through both descriptor creation paths.
