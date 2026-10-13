---
"@agentproto/runtime": patch
"@agentproto/sandbox": patch
"@agentproto/sandbox-e2b": patch
---

Sandbox boxes are kept alive while their session is working: the proxy re-arms the box lifetime (throttled to once per 60s) when a prompt is dispatched and as box events stream back, never while idle. The e2b `extendTimeout` clamps to the 1h account cap, and `BootedSandbox`/`SandboxAgentSessionHost` expose the box's configured `lifetimeMs`.
