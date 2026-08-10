---
"@agentproto/adapter-hermes": patch
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

**Hermes nativeTerminalResume gated on Node ≥22.5** — hermes TUI uses node:sqlite which is unavailable on older runtimes; the capability is now computed at import time so restart falls back to ACP agent-cli instead of crashing.

**augmentWithFsResume backfills adapterSessionId** — when never captured (session killed before ACP handshake), backfill it from filesystem probe so agent restart can attempt ACP-level resume in addition to PTY-native restart.

**restartAsTerminal opens transcript on fallback** — when restart falls back to agent-cli (no PTY available), open the conversation transcript view instead of the agent-mirror pseudo-terminal.
