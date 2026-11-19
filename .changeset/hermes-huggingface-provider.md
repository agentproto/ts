---
"@agentproto/runtime": minor
"@agentproto/adapter-hermes": minor
---

Hermes sessions started with a Hugging Face access profile now work end to end: the profile resolver injects `HF_TOKEN` (keychain, never a plaintext file) and the model is sent as `huggingface:<model>` so Hermes selects its native `huggingface` provider per session (its config.yaml `model.provider` otherwise wins over env). The hermes manifest declares `HF_TOKEN` as a provider key.
