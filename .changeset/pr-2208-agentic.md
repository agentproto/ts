---
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
"@agentproto/sandbox-computer": minor
---

Make computer sandbox boot visible, bounded, and honest about impossible capacity: register a `starting` session row before the box boots and adopt it once the driver session exists (with a new `sandbox` provisioning phase), give the whole provider boot one deadline that fails with a typed `sandbox_boot_timeout` naming the stuck phase, refuse requests above the tenant's total budget with `sandbox_capacity_exceeds_budget`, and log one daemon line per boot phase through the new optional `SandboxBootOpts.log`. `sandbox-computer` also gains `ComputerControllerClient.getCapacity()`, the `bootDeadlineMs` config, and additive error fields (`budget`, `phase`, `timeoutMs`, `sandboxId`); its bump is `minor` because those exports are new.
