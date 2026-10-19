---
"@agentproto/runtime": patch
"@agentproto/sandbox-computer": patch
---

`computer` sandbox provider: `daemonRoute` no longer requires `gatewayUrl`. A configuration that sets both is rejected with a clear error instead of silently falling back to the explicit gateway, and the `setup_sandbox_provider` fields document that `gatewayUrl` is optional and mutually exclusive with `daemonRoute`.
