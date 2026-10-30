---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

When `defaults.nativeHooks.command` is unset, the projected `PreCompact` hook now runs the CLI that serves the daemon by absolute path (`'<node>' '<cli-entry>'`), so a launchd/systemd daemon with a minimal `PATH` still finds it; an explicit value still wins. The runtime exports `servingCliCommand` and `setServingCli`, and the CLI's `serve` command registers the serving CLI for spawned and restarted sessions.
