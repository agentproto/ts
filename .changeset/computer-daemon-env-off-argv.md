---
"@agentproto/sandbox-computer": patch
---

Send the descriptive join metadata (`AGENTPROTO_JOIN_NAME`, `_PROVIDER`, `_SANDBOX_ID`, `_LABELS`) to the box daemon through its start command instead of the create env, so the controller's argv check no longer refuses the daemon start exec when a short value such as `computer` appears in the box origin.
