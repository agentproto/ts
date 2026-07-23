---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Add opt-in eager resume-on-boot for session survivability (PR-4). After a daemon restart, eligible agent-cli sessions are eagerly re-spawned without waiting for a prompt, restoring liveness to orchestrated fleets and completion policies. Feature is off by default (set `daemon.resumeSessionsOnBoot: true` to enable) and includes proper concurrency control and cross-process safety for multi-daemon deployments.
