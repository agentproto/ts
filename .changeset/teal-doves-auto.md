---
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
"@agentproto/sandbox-computer": patch
---

Make computer sandbox boot visible, bounded, and honest about impossible capacity:

- refuse a request above the tenant's total budget with `sandbox_capacity_exceeds_budget` and no retry hint
- give the whole provider boot one deadline and fail with a typed `sandbox_boot_timeout` naming the stuck phase
- log one daemon line per boot phase
- register a `starting` session row before the box boots and adopt it once the driver session exists
