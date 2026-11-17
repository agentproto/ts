---
"@agentproto/adapter-claude-code-cloud": patch
"@agentproto/skill-pack-agentproto": patch
---

Docs: a cloud spawn's `model` does apply (through `ANTHROPIC_MODEL`), the account is always the daemon user's claude.ai login (`access`, slots and presets are skipped), and a `claude setup-token` credential cannot create cloud sessions.
