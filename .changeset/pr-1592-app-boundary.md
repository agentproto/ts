---
"@agentproto/runtime": minor
"@agentproto/app-kit": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/command-sandbox": minor
"@agentproto/cli": patch
---

App-spawned sessions (`app_run`, and workflow agent steps whose workflow carries an `appId`) now get filesystem zones: the installed app source is read-only, the run workspace and app `data/` dir are writable, everything else is denied. Enforced on the daemon's own file/command tools always; on the harness's native tools (claude-code) via `@agentproto/command-sandbox` zoned mode plus host `CLAUDE.md`/`AGENTS.md` exclusion when the adapter and OS sandbox support it. Apps opt into `boundaries: { enforce: "required" }` in `defineApp`/`APP.md` to refuse a spawn instead of silently downgrading when native enforcement isn't available.
