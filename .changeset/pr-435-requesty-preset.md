---
"@agentproto/provider-presets": minor
"@agentproto/adapter-claude-code": minor
"@agentproto/adapter-claude-sdk": minor
"@agentproto/runtime": patch
---

Add the Requesty gateway preset (`requesty`), giving claude-code and claude-sdk
a mode for Requesty's ~560-model Anthropic-compatible router. Base URL is
`https://router.requesty.ai` — the Anthropic surface is served at
`/v1/messages`, not the `/anthropic/v1/messages` the vendor docs claim.

Also fixes the shipped `openrouter` preset, whose base URL carried a `/v1`
suffix. The claude binary and the Agent SDK append `/v1/messages` themselves, so
every openrouter-mode spawn requested `/api/v1/v1/messages` and 404'd — surfaced
to the harness as the misleading "model may not exist or you may not have access
to it". Corrected to `https://openrouter.ai/api`; a preset test now asserts no
anthropic-flavored base URL ends in `/v1`.
