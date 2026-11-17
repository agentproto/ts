---
"@agentproto/runtime": minor
---

New MCP tool `desktop_conversation_create { app: "codex", cwd, prompt, model?, sandbox?, timeoutMs? }`: creates a Codex conversation with `codex exec --json` (read-only unless `workspace-write` is asked) and returns the thread id (`codex:<id>`) and its first answer. The thread is stored as a `codex exec` thread, so `desktop_conversation_list` / `read` / `ask` reach it; the Desktop sidebar may not show it. `app: "claude"` is refused with the reason: Claude Desktop has no supported way to create a chat from outside the app.
