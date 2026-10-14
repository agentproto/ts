---
"@agentproto/cli": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-hermes": patch
"@agentproto/adapter-gemini": patch
"@agentproto/adapter-pi": patch
"@agentproto/adapter-mastracode": patch
"@agentproto/adapter-copilot-cli": patch
---

Harness freshness + safe upgrades: `agentproto harness outdated|check|upgrade`. Adapters can now declare an AIP-45 `upgrade` block (latest-version source, in-place upgrade argv, optional exact-version rollback); the six globally-installed harnesses (opencode, hermes, gemini, pi, mastracode, copilot-cli) declare one. `upgrade` re-runs an ACP smoke probe (initialize + session/new, no prompt) after every upgrade and rolls back to the recorded previous version when it fails, guarded by the `version_check.range` check and a live-daemon-session check (both bypassable with `--force`).
