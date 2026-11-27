---
"@agentproto/cli": patch
---

`agentproto daemon stop|restart|uninstall` now refuse to act (exit 1, with a clear message) when the current HOME or port differs from the registered service's, so a daemon started under another HOME or port, such as an isolated test daemon, can no longer take down the per-user service by accident. Pass `--force-service` to target the service anyway.
