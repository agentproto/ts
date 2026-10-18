---
"@agentproto/cli": minor
---

`agentproto daemon` now supports Linux: `install`/`uninstall`/`start`/`stop`/`restart`/`status`/`logs` manage a systemd `--user` unit (falling back to a detached-serve pidfile daemon when the box has no usable systemd user session). The onboarding `daemon` step and doctor use the same backend detection instead of reporting "no service manager support on linux yet".
