---
"@agentproto/model-catalog": patch
---

Fix HuggingFace provider environment variable from `HUGGINGFACE_API_KEY` to `HF_TOKEN` to align with ecosystem conventions and resolve credential resolution failures in model-derived routing through opencode.
