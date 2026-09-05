---
"@agentproto/runtime": minor
---

feat(sandbox): forward config-default wallets to sandbox spawns

Sandboxed agent spawns can now use credentials configured in `defaults.adapters.<slug>.auth`. The host resolves the configured wallet and forwards it to the sandbox, ensuring the box bills on the same credential the host would use. Unconfigured sandboxes remain credential-free, and error handling clearly distinguishes between access profile and config-default wallet resolution failures.

Adds `explicitConfig` boolean to `ResolvedSpawnAuthMaterial` to track whether auth came from config vs per-spawn request, enabling proper boundary enforcement and credential forwarding logic.
