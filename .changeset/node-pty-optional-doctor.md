---
"@agentproto/cli": patch
---

feat(doctor): report terminal sessions as unavailable (node-pty not built) as a warning instead of leaving it silent — node-pty is an optional dependency, so a missing native build only disables PTY terminals; agent sessions are unaffected. install.ps1 keeps `--allow-scripts=node-pty` as best effort.
