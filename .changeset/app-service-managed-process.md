---
"@agentproto/runtime": minor
"@agentproto/app-kit": minor
"@agentproto/cli": minor
---

App services run as deterministic managed processes: replace the LLM-prompted owner session with a detached, non-PTY child process spawned and supervised by the daemon (sessions-registry registration, structured `cwd/command/args` service declarations with legacy `entry` compatibility, restart backoff + rolling-window cap, group-kill cleanup gated by PID-identity checks, per-app serialization, own `daemon.resumeServicesOnBoot` knob defaulting on, and full reconcile purging services removed from a manifest).
