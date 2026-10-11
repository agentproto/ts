---
"@agentproto/runtime": patch
---

Sentinel: coalesce queued notices about the same thing (composable `SentinelCoalesceRule` registry; default rules for CI per PR+head and pushes per PR), replace-in-place in the prompt queue with `coalescedCount`, and a per-head CI rollup in the `local-gh` provider (first failure fires at once, success only once every check is done; partial passes are silent). Webhook check-suite summaries now name the app and short head sha.
