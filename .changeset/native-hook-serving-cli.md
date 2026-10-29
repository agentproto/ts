---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

When `defaults.nativeHooks.command` is unset, a projected PreCompact hook now runs the CLI that serves the daemon by absolute path, so a launchd daemon with a minimal PATH still finds it. An explicit value still wins. The runtime exports `servingCliCommand` and `setServingCli` for the CLI's `serve` command.
