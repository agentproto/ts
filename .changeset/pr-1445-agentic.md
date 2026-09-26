---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Add a zod mirror of `AgentprotoConfig` (`config-schema.ts`) with a declared registry of writable key paths (`CONFIG_KEYS`), exposed as the new `@agentproto/runtime/config-schema` subpath. `loadConfig` now validates config files (warn-only), and `agentproto config set`/`unset` validate values, reject non-writable secret/lockout keys, and warn on unknown keys.