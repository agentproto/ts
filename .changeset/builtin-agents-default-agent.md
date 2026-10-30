---
"@agentproto/runtime": minor
---

The built-in `executor` and `supervisor` roles declare `delegatesTo`. `defaults.spawn.defaultAgent.root` and `.nested` choose the agent a spawn that names none binds (today's values `supervisor` and `executor`); `defaults.defaultRoleDepthCutoff` stays the boundary and is deprecated. A session records the agent it is bound to as `meta.agentSlug`, which message envelopes expose as `from.agentSlug`.
