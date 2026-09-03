---
"@agentproto/adapter-mastra-agent": patch
---

Fix deadlock when a tool suspension (e.g. `submit_plan`) lacks an approval responder. Previously, follow-up prompts would be silently queued and never executed while the session appeared healthy. The fix rejects new prompts when a suspension is pending, provides visibility via notification messages, and properly cleans up suspension state after cancellation.
