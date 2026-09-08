---
"@agentproto/runtime": patch
---

Auto-install the spawned adapter into sandbox boxes: a sandboxed `agent_start` now prepends `@agentproto/adapter-<slug>@latest` (plus `@anthropic-ai/claude-code@latest` for the `claude-code` adapter) to the sandbox spec's `config.installPackages` when not already declared, so the adapter survives the box's boot-time CLI update; a caller-declared pin always wins and non-sandbox spawns are unchanged.
