---
"@agentproto/cli": minor
---

Extract pure helper functions from watch loops for testability and reuse: `isTerminalSession`, `sessionRowLabel`, `terminalKindMark`, `attachMode`, `decodeWatchKey`, and the `WatchKeyAction` type. Both watch modes now decode keypresses through the same centralized function, eliminating duplication.

Add support for the `s` key to show a session's Story/conversation in both watch modes — same peek-and-return flow as attach/mirror.

Improve terminal session labeling: terminal sessions without an explicit name are now labeled by the command that launched them (e.g., `claude --resume …`) instead of opaque session IDs, making supervisors recognizable at a glance.
