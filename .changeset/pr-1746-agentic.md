---
"@agentproto/secrets": major
"@agentproto/pair-client": major
"@agentproto/runtime": minor
"@agentproto/apps": patch
"@agentproto/cli": patch
---

Remove every link to the retired cli.agentproto.sh host. The `PAIR_WEB_URL` export is removed from secrets and pair-client (breaking). The daemon no longer trusts the cli.agentproto.sh origin by default, and `remote_enable` only returns a `phoneUrl` when `@agentik/session-chat` is installed. The session-story panel's full-panel link now opens the daemon's live-session panel.
