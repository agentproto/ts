---
"@agentproto/runtime": patch
---

Persist a workflow run's terminal state before draining the app ledger, so `flush()` waits for the lease sidecar removal once the run is observed done or failed.
