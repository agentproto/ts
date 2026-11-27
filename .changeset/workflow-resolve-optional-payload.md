---
"@agentproto/runtime": patch
---

`workflow_escalation_resolve`: `payload` is optional again. The approval form (`approvalId` + `approved` + `who`, as sent by `agentproto workflow resolve --approve|--reject` and the stageboard approval card) and the escalate form were rejected with "-32602 ... expected nonoptional at payload" before the handler ran. A run parked at a `kind: "suspend"` step called without a payload now gets an explicit `missing_payload` error.
