---
"@agentproto/cli": patch
---

Fix `agentproto sentinel ...` failing with `unrecognised argument(s): sentinel` — the verb was implemented and help-documented but never registered in the CLI's dispatch table.
