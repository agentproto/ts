---
"@agentproto/app-kit": minor
---

Add the AIP-53 `services` production-hosting field: a validated, frozen `services: [{ name, entry, port? }]` array on `AppDefinition`/`AppHandle` that `defineApp`, `emitApp` and `loadAppHandle` carry verbatim. app-kit never executes a service `entry`; the host spawns one keep-alive service-owner session per entry at install time. The `services` load error shares the `invalid services declaration` phrase with the runtime install-time launcher.
