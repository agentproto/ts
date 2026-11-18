---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

A provider TUI launched as a PTY (`agentproto sessions terminal -- claude|codex|opencode|hermes|…`) can now RECEIVE `message_send`, not only emit it: the message is parked in the terminal's inbox and typed into the PTY (bracketed paste + Enter) once the TUI is idle (no activity-grade paint for `quietMs`; invisible chunks and isolated status-bar clock ticks are ignored). Plain shells still refuse. `codex` and `copilot` bare bins are now classified as provider TUIs. `sessions terminal --access <profile>` (and a preset's `accessProfile`, `terminal_start.accessProfile`, `POST /sessions/terminal {accessProfile}`) pins a named auth profile onto the PTY (credential env set, conflicting vars scrubbed, `accessProfile` echo recorded), failing closed when it cannot be resolved.
