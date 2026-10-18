---
"@agentproto/runtime": patch
---

The `cloudflare-managed` and `cloudflare-provisioned` tunnel providers no longer spawn `cloudflared` when `stop()` ran while `start()` was still awaiting preflight or remote provisioning. `start()` now throws `TunnelStartAbortedError` (settled as `stopped` by the registry) instead of starting a process nothing can stop. Same race `cloudflare-named` and `cloudflare-quick` were already fixed for.
