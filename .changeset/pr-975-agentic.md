---
"@agentproto/cli": minor
---

Implement PATH self-healing for daemon start/restart. The daemon's plist now automatically refreshes its `EnvironmentVariables.PATH` on every `kickstart` by probing a login shell and rewriting the plist if the PATH changed, eliminating the need to manually re-run `daemon install` after installing new CLI tools (e.g., via `uv tool install`).
