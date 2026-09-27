---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Surface WHY a session ended: add a single-source `SessionEndReason` enum (`SESSION_END_REASONS`, `isKnownSessionEndReason`, `isProviderLimitError`), thread a `reason` through `SessionsRegistry.kill()` (operator-completed/operator-stopped/policy-cleanup/parent-exited/forgotten), tag cost-cap and provider-usage-limit teardowns, add an idempotent "mark as completed" outcome relabel on already-terminal rows (`termination.previousReason`), and a `sessions stop --completed` CLI flag.
