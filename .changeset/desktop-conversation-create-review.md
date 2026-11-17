---
"@agentproto/runtime": patch
---

`desktop_conversation_create` review follow-ups: a timed-out creation now really stops the `codex` process (SIGTERM, then SIGKILL after a grace period, returning once the child closed); a failed or timed-out creation is an error result, like `desktop_conversation_ask`; the tool description warns that `cwd` is unscoped and `workspace-write` is not limited to agentproto workspaces; `ask` only falls back to the Claude project path for the transcript shortcut when the chat is a Claude one.
