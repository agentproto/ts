---
"@agentproto/runtime": patch
---

Don't duplicate a salient arg already baked into a curated tool title — ACP tool calls were rendering `Read src/foo.ts src/foo.ts`.
