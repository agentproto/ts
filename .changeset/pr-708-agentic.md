---
"@agentproto/runtime": patch
"@agentproto/sandbox-box": minor
---

Add Box sandbox provider for ascii.dev Box cloud computers. The provider boots a Box, installs an always-on systemd unit for the agentproto daemon, and exposes the daemon's MCP endpoint via a stable hostname. Includes comprehensive test coverage for boot, connect, pause, and stop lifecycles.
