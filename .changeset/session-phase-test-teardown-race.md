---
"@agentproto/runtime": patch
---

Test-only: the session activity-phase test now retries its temp-dir teardown instead of racing the transcript stream's async close (fixes an intermittent ENOTEMPTY in CI).
