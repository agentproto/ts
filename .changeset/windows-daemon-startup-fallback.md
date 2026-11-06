---
"@agentproto/cli": patch
---

Windows `daemon install` now falls back to a per-user Startup-folder launcher when `schtasks /Create` is refused by group policy, and starts the daemon immediately. `start`, `stop`, `restart`, `status` and `uninstall` recognise the fallback mode; the docs no longer claim a scheduled task is the only no-admin path.
