---
"@agentproto/adapter-codex": patch
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": minor
"agentproto-vscode": patch
---

Add file-based ("external") subscription login support for Codex and future adapters (Gemini). File-based subscriptions have the CLI read its own login file (~/.codex/auth.json), so the daemon injects NOTHING and only scrubs conflicting api-key environment variables, maintaining the money-safety invariant that no OAuth bearer is ever written to an api-key channel.

Includes:
- New `authSubscription: { external: true }` shape in adapter manifests for CLI-resident login files
- `verifyLocalLoginPresent()` function to fail-loud on missing external login before spawn
- Comprehensive test coverage for both profile-based and config-based spawn paths
- VSCode UI integration for "Use my existing Codex login" option
- Documentation explaining both bearer-injection (Claude Code) and file-based (Codex/Gemini) shapes
