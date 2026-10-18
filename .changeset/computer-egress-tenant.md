---
"@agentproto/sandbox-computer": patch
"@agentproto/runtime": patch
---

`computer` sandbox provider: forward a configurable `egress` allowlist on create (the controller denies all egress, DNS included, without one), and add an optional `tenantId` setup field that fills `COMPUTER_TENANT_ID` from the stored provider profile.
