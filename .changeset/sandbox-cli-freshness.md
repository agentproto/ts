---
"@agentproto/sandbox-e2b": minor
---

e2b sandbox provider: keep the baked `@agentproto/cli` fresh and open the daemon's origin allowlist. When this provider starts the daemon (i.e. the template didn't autostart it), it first runs `npm i -g @agentproto/cli@latest` so a stale template bake no longer pins callers to an old agentproto version — gated by a new `updateCliOnBoot` config option (default true). The `agentproto serve` command now also passes `--allow-origin https://<host>` so the daemon accepts connections from this host process against the sandbox's public origin.
