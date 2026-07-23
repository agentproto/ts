---
"@agentproto/command-sandbox": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": patch
---

Extract OS-level process confinement (macOS Seatbelt / Linux bubblewrap) into shared `@agentproto/command-sandbox` package to resolve circular dependency, enabling both `command_execute` tool and adapter child processes to use identical backends. Add `extraWritePaths` support for write-capable directories (e.g., toolchain self-managed installs), and empirically-validated metadata-only `$HOME` allow for npm/npx compatibility. Apply confinement to agent-cli spawns in both ACP/MCP and print-protocol arms.
