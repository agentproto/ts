---
"@agentproto/driver-agent-cli": minor
---

Fix spawn ENOENT on launchd daemons: resolve npx/npm to sibling binaries, ensure exec dir on child PATH, and disambiguate missing cwd from missing binary in error messages.
