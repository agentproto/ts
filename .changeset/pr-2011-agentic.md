---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

`agentproto serve` now re-ensures every installed app's `services:` owners at boot, after the resume and continue-on-boot passes. `ensureServices` previously ran only on the install path, so an app-service owner killed by a daemon restart (`endedReason: "daemon-restart"`, not covered by its `crashed`/`error` restartPolicy) stayed down until the next reinstall. The boot pass force-replaces every recorded owner — signalling any pid left in its pid file first so an orphaned child does not hold the port — gated by the same `daemon.resumeSessionsOnBoot` knob as the other boot-automation passes. Runtime gains the internal `reensureAppServiceOwners` / `buildAppServiceEnsurer` helpers (not re-exported from the package root); the CLI invokes and reports the new pass.
