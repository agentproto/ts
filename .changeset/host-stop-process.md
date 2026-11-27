---
"@agentproto/cli": minor
"@agentproto/harness": minor
"@agentproto/runtime": minor
---

Stop ONE process that saturates the host, through a narrow daemon-checked right.

- **`agentproto host stop-process <pid> --reason <text>`** (`POST /host/processes/:pid/stop`) stops a process only when it descends from a live daemon session. It refuses the daemon, its ancestors, a session's own adapter process, another user's process, and anything outside every session. SIGTERM first; SIGKILL after `--grace` only if the pid still runs the same command. Every attempt is logged with the caller and the reason (`~/.agentproto/host-stop-process.log`), and the owning session gets a system notice.
- **`agentproto host guard`** escalates a whole-disk scan (`find`/`bfs`/`fd`/`du` rooted at `/`, the home dir, `/Volumes`) at once, whatever the host level, once per pid. The escalation names the owning session and the exact stop command. Scan detection now also reads a root that follows an option taking an argument (`bfs -S dfs /`, `-j 8`, `-D`, `-O`, BSD `find -f`), and `/System/Volumes/Data`.
- **`defaults.permissionGrants`** (operator-only) adds Claude Code `permissions.allow` rules per session label, written into the isolated settings at spawn, restart and resume. The built-in default lets `host-guard-escalation` run `Bash(agentproto host stop-process:*)` and nothing else; `{}` removes every grant. The harness gains `permissionAllow` on `start()`.
