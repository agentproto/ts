---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

`agentproto serve` now re-ensures every installed app's `services:` owners at boot, right after the eager-resume and continue-on-boot passes. Previously `ensureAppServiceOwners` only ran from `app_install`, so an owner session killed by a daemon restart (`endedReason: "daemon-restart"`, not covered by its `crashed`/`error` restartPolicy) stayed down until the next reinstall. The boot pass force-replaces every recorded owner — signalling any pid left in its pid file first, so an orphaned child doesn't hold the port — gated by the same `daemon.resumeSessionsOnBoot` knob as the other boot-automation passes.
