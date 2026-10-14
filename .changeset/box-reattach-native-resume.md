---
"@agentproto/runtime": patch
"@agentproto/harness": patch
---

A session restarted on its still-alive sandbox box now resumes the adapter's own conversation inside the box (`agent_start` gained an internal `resumeSessionId` resume target; a rejected id falls back to a fresh in-box spawn plus the transcript digest, as before).
