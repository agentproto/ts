---
"@agentproto/harness": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/adapter-antigravity": patch
"@agentproto/adapter-claude-code-cloud": patch
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-copilot-cli": patch
"@agentproto/adapter-gemini": patch
"@agentproto/adapter-grok-cli": patch
"@agentproto/adapter-hermes": patch
"@agentproto/adapter-jcode": patch
"@agentproto/adapter-mastra-agent": patch
"@agentproto/adapter-mastracode-inprocess": patch
"@agentproto/adapter-mastracode": patch
"@agentproto/adapter-openclaw": patch
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-pi": patch
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

AIP-45 step 2 of 2: the runner formerly published as `@agentproto/driver-agent-cli` now ships as `@agentproto/harness` (on npm since 2.15.0). It gains `defineHarness`, an alias of `defineAgentCli` registered as the AIP-70 `harness/v1` entry, and `SPEC_NAME` is `harness/v1`.

Users of the old session presets move to `@agentproto/session-presets`; users of `@agentproto/driver-agent-cli` move to `@agentproto/harness` (same API, `defineHarness` added). `@agentproto/driver-agent-cli` stays published as a deprecated shim that re-exports the harness package unchanged, so existing installs keep working.

The switched dependents only rename their dependency and import specifiers, hence the patch bumps.
