---
"@agentproto/runtime": patch
---

After a daemon restart, re-arm the remote-mode bearer gate from its persisted token hash before relaunching autostart tunnels, and let `restoreOnBoot` also retry autostart tunnels left in `error` (e.g. refused earlier because the gateway was unprotected). A public tunnel to the daemon's own port now comes back by itself after a restart.
