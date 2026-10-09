---
"@agentproto/adapter-opencode": minor
"@agentproto/runtime": minor
---

opencode executors now start lean by default. A first request for "reply OK" was ~140k input tokens (the global `agentproto` MCP bridge's ~280 tool schemas, the skills list and the repo's `AGENTS.md`); the new `lean` context mode on the opencode adapter disables external skills, project config / `AGENTS.md` autoload and that bridge, bringing it to opencode's own ~8k floor. `defaults.adapters.opencode.contextProfile` (and `contextProfile` per spawn) opts out or in.
