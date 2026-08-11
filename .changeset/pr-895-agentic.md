---
"@agentproto/cli": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/runtime": patch
---

Fix daemon crash from unhandled spawn errors and PATH-based node resolution issues:

- Add error event listeners to spawn processes to prevent unhandled exceptions from crashing the daemon
- Resolve `bin: "node"` in agent CLI definitions to `process.execPath` instead of relying on PATH lookup, preventing failures in launchd environments with minimal PATH
- Fix auth method availability detection for models with `modelDerivedApiKey` by checking both `authSubscription` and `modelDerivedApiKey` for oauth-bearer eligibility
- Improve test mocks to properly emit spawn events, enabling proper coverage of spawn failure scenarios
