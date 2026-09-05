---
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
---

Add `agent_start.appServe`: with `sandbox`, the daemon installs the app on the box (the box daemon's `app_install`), launches `agentproto app serve --host 0.0.0.0 --port <port>` detached through the box's `command_execute` (seeding the box command allowlist), and stamps the public URL on the descriptor/result; `SandboxAgentSessionHost` now carries `mcpUrl` so callers can drive the box's other daemon tools.
