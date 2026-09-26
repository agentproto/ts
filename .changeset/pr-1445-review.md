---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Add config.json zod schema + CONFIG_KEYS registry; CLI config set/unset now type-validate values (writable/secret gating stays CLI-exempt, reserved for a future config_set)
