---
"@agentproto/runtime": patch
---

`desktop_conversation_read` / `desktop_conversation_ask` on a Claude Desktop chat whose cwd is a symlinked path (macOS `/tmp/x` → `/private/tmp/x`) no longer fail with "JSONL file not found": `claudeCodeProjectDir` falls back to the realpath slug when the typed path has no project directory. Both tools also accept the `externalId` the list shows (`cc:<id>` / `codex:<id>`) as the conversation id instead of answering "no … Desktop conversation".

Exporting a conversation to the native Claude Code store (`writeToNativeStore`, `claude --resume`) from a symlinked cwd now writes under the resolved cwd's project directory, the one Claude Code reads. The `desktop_conversation_read` / `ask` tool schemas document the `externalId` form of `id`.
