---
'@agentproto/llm-endpoint': minor
---

Add a focused OpenAI Responses API facade (`POST /v1/responses`) for Codex custom providers, plus a transparent `POST /v1/chat/completions` surface and direct OpenAI provider routing.

- Responses requests validate, translate to chat/completions, and convert upstream JSON/SSE back to the Responses API format.
- Routing is provider-transparent (`provider/model`) on the OpenAI surfaces; old codenamed alias packs are removed from defaults.
- Claude-shaped compatibility aliases are now accepted only from explicit local packs (`packs.local.json`) on the Anthropic Messages path.
- Adds `openai` as a first-class provider using `OPENAI_API_KEY` and `api.openai.com/v1/chat/completions`.
