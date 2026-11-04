---
"@agentproto/runtime": patch
---

Run the `model-answers` preflight on credentialed spawns of a Zen free model (`opencode/<id>-free`, `opencode/big-pickle`). The free cap is per source IP and no key changes it, so the unauthenticated probe is valid there; before, any spawn carrying auth (CI's api-key lane included) silently skipped the preflight and the placement ladder never dropped a burned IP. Paid and Go-route models still skip.
