---
"@agentproto/adapter-codex": major
"@agentproto/driver-agent-cli": patch
"@agentproto/cli": patch
---

Migrate Codex adapter to maintained `@agentclientprotocol/codex-acp` bridge: removed fixed model defaults, switched model delivery from CLI args to ACP session config, changed model option from enum to dynamic string type. Simplified runtime to treat Codex generically (no special auth-awareness); removed `detectCodexAuthMode()` and related detection logic. Updated all test fixtures and documentation references.
