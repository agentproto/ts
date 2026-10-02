---
"@agentproto/runtime": minor
---

App runtime output moves out of the app's code dir: `ui.build` logs are written to `~/.agentproto/logs/app-ui-build/<app>-<hash>.log` (honors `AGENTPROTO_HOME`) instead of `<appDir>/.agentproto/ui-build.log`, and apps installed from a git URL or `.agentapp` default their `dataDir` to `~/.agentproto/app-data/<appId>` instead of `<appDir>/data`. Existing installs keep their recorded `dataDir`.
