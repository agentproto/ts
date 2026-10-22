---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Auth-profile switching across the fleet and in the VS Code extension.

`agentproto sessions switch-profile --from <profileRef> --to <profileRef>` moves every session billing against one profile onto another through the daemon's restart-with-override route, with `--dry-run` and `--json` output.

The runtime re-arms `prompt-session` cron jobs on a session restart: when the conversation continues under a new session id, jobs that named the retired id are re-pointed at the successor (persisted with the job file) instead of failing their next tick. Agent-label targets are resolved at fire time and are left alone.

`agentproto-vscode`'s session auth-profile picker now lists every profile the daemon knows (eligible ones first, the rest flagged), and applies the pick via `restartSessionWithOverride`, so a session whose route the catalog does not know no longer offers only "+ add profile".
