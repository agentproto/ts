---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

`app_install` accepts an expected `sha` (git commit) / `sha256` (`.agentapp` digest) and refuses any mismatch before installing. A remote app's `ui.build` shell command no longer runs by default: a `.agentapp` never builds, a git install needs `allowBuild: true`, and without consent `ui.build` is dropped from the installed record so later UI requests can't run it either. CLI: `app install --sha`, `--sha256`, `--allow-build`. `AppSource` is now defined once (`app-registry.ts`).
