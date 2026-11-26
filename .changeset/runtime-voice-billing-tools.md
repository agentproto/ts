---
"@agentproto/runtime": minor
---

Register `list_voice_providers` / `setup_voice_provider` and `list_billing_providers` / `setup_billing_provider` on the daemon, produced by the voice and billing registries (both built on `makeProviderFamily`). The runtime holds no provider; credentials come from the host environment and are never returned.
