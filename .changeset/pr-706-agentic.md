---
"@agentproto/runtime": patch
---

Fix TypeScript type-checking errors: resolve `vi.spyOn` generic type incompatibility in crash-reaper.test.ts via structural typing, and make `crashDetectIntervalMs` optional in RegisterDaemonHealthToolsOptions for backwards compatibility with code predating this configuration knob.
