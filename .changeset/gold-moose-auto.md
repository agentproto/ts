---
"@agentproto/catalog-sync": minor
"@agentproto/model-catalog": patch
---

Add the `audio:openai-live` generator: OpenAI live/realtime audio ids now auto-sync from the pinned `/v1/models` snapshot (weekly catalog-sync workflow) into `OPENAI_LIVE_MODELS`, like the LLM halves. Capabilities + pricing stay curated in `AUDIO_MODEL_CATALOG` — each synced id carries `needsCuration` until a curated entry claims it — and the new curated `openai/gpt-live-1` entry (base GPT-Live tier, published $0.05/min) completes the GPT-Live pair. New curation-bridge helpers (`openaiLiveIdsNeedingCuration`, `isCuratedOpenAIAudioModel`) and an anti-drift test keep curated live engines on ids OpenAI actually serves.
