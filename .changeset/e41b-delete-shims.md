---
"@agentproto/harness": major
"@agentproto/agency": major
"@agentproto/cli": patch
"@agentproto/command-sandbox": patch
"@agentproto/adapter-antigravity": patch
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-code-cloud": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-copilot-cli": patch
"@agentproto/adapter-gemini": patch
"@agentproto/adapter-grok-cli": patch
"@agentproto/adapter-hermes": patch
"@agentproto/adapter-jcode": patch
"@agentproto/adapter-mastra-agent": patch
"@agentproto/adapter-mastracode": patch
"@agentproto/adapter-mastracode-inprocess": patch
"@agentproto/adapter-openclaw": patch
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-pi": patch
---

Remove the `defineAgentCli` export from `@agentproto/harness` (it aliased `defineHarness`; use `defineHarness`) and the `defineAgencyV2` export from `@agentproto/agency` (it aliased `defineAgency`; use `defineAgency`). The nine deprecated re-export shim packages are deleted from the repo; use their replacements (`provider-kit`, `agency`, `app`, `doctype`, `harness`, `inference-endpoint`, `bridge`, `pairing`, `processor`). The in-repo adapters and the CLI now call `defineHarness`; no behaviour change.
