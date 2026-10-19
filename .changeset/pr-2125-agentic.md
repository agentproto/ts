---
"@agentproto/runtime": minor
"@agentproto/sandbox-e2b": minor
---

Sandbox cost guardrails and device liveness:

- e2b: a box whose spec declares `lifecycle.pause_after_idle` is created with `lifecycle.onTimeout: "pause"`, so a box that outlives its provider timeout is parked instead of destroyed. New `config.onTimeout` (`"pause" | "kill"`) overrides it.
- runtime: the idle reaper honours a box's own `lifecycle.pause_after_idle` window when it is shorter than `daemon.sandboxIdleReapAfterMs` (new descriptor field `sandboxPauseAfterIdleMs`).
- runtime: `device:` spawns probe the paired host's `/health` when it isn't already known online, and fail fast with a typed `device_offline` code (HTTP 400) instead of a generic `sandbox_boot_failed`, so a caller can fall back to a sandbox or queue the work.
