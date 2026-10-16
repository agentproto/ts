---
"@agentproto/runtime": minor
---

Launch service owners for an app's declared `services:` block at `app_install` time: one keepAlive + restartPolicy owner session per entry (spawned through the same infra as agents) supervises the entry as a detached child, with per-service ownership (appId + name + owner sessionId + pid) persisted beside the installed-app registry. `app_uninstall` kills every owner session and recorded pid; a reinstall replaces dead owners without spawning a duplicate.
