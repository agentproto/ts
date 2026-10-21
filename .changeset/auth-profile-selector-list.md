---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Auth-profile switching: pick an existing profile for a session, and move every session off a profile in one command.

The VS Code extension's session "Auth profile" picker only offered "+ add profile" — the existing profiles in `~/.agentproto/auth-profiles.json` were never listed, because the picker showed only the profiles the CATALOG marked eligible for the session's route, and that set is empty whenever the route lookup misses. The picker now lists the profiles the daemon knows (name/label only, never key material) and, when one is picked, restarts the session onto it via `POST /sessions/:id/restart` with `access.profileRef`.

The new `agentproto sessions switch-profile --from <profileRef> --to <profileRef>` does the same for a whole fleet: every session currently billing against the `from` profile is restarted onto the `to` profile in one command.

- The restart keeps the session's POSTURE — switching the wallet never silently changes what the agent may do.
- A restart continues the conversation under a NEW session id, so the cron jobs that targeted the old id are RE-ARMED: their target moves to the successor id (persisted with the job file), instead of failing the next tick with "session not found". Agent-label targets are resolved at fire time and need no re-arm.
