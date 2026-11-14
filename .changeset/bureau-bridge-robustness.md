---
"@agentproto/runtime": patch
---

The Bureau approval bridge no longer loses a human's decision when Bureau is down or answers non-2xx: the decision is kept next to the approval record and retried with a bounded backoff, and once at boot, until Bureau answers 2xx or a final 4xx. An agent that retries the same Bureau request reuses the pending approval, `approvalId` and `waitWith` are echoed into `structuredContent` too, and an invalid or already-past `expiresAt` falls back to now + 15 min.
