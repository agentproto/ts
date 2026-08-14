---
"@agentproto/plugin-local-browser": minor
"@agentproto/skill-pack-bureau": minor
---

Relocate local-browser skill into skill-pack-bureau. Consolidates skill distribution into the dedicated skill pack; plugin functionality and TypeScript API remain unchanged. Users should install the skill via `agentproto install skill/local-browser --pack bureau-plugin` instead of from the plugin package.
