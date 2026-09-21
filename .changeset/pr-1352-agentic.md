---
"@agentproto/llm-endpoint": minor
---

Add a self-hosted "forge" provider: `forge/<model>` routes to an env-configured OpenAI-compatible upstream (`FORGE_BASE_URL`, optional `FORGE_API_KEY`) on all three surfaces, with live LoRA adapter discovery merged into `GET /v1/models`.
