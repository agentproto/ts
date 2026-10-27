---
"@agentproto/app": patch
---

Docs-only sync: the `@agentproto/app` README now documents the AIP-53 `services` production-hosting surface as deterministic managed child processes, including the structured `{ name, command, args?, cwd?, port? }` declaration, legacy `entry` compatibility, boot re-ensure via `daemon.resumeServicesOnBoot`, and manifest reconciliation on install/uninstall.
