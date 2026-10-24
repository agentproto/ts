---
"@agentproto/runtime": patch
---

Fix sentinel triage key timing: record the coalesce key only after a successful delivery so a failed send is retried without being classified as a repeat of itself, and guard the repeat window against backwards clock steps.
