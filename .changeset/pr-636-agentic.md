---
"@agentproto/runtime": minor
---

Add resume attempt cap and backoff mechanism to prevent infinite retry loops when an adapter consistently fails to resume a session. Introduces `MAX_RESUME_ATTEMPTS` constant, `canResume()` function for cap-aware eligibility checking, and `ResumeDisabledError` exception. Session resume attempts are persisted across daemon restarts and reset on successful completion, ensuring the cap survives crash-loops and prevents exhaustion of resources.
