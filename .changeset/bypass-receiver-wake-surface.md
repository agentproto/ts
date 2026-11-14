---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

The `claude-socket` wake now reaches Claude Code sessions in `bypassPermissions` when the user's `crossSessionInbound` setting is `accept` (read-only from `~/.claude/settings.json`). Without it the frame is still sent, the message is also parked in the inbox, and `message_send` / `message_parent` return `wake: { written: true, reason: "held-by-receiver-bypass", hint }`; the daemon logs `[socket-wake] to= written= reason= pid= rowMode=` and `daemon_health` / `/health` list one `warnings` entry per receiver. `agentproto doctor --fix` adds `"crossSessionInbound": "accept"` (backup, atomic write, other keys kept, no-op if already set) and `agentproto doctor` flags the held receiver.
