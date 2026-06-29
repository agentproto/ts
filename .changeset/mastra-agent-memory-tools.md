---
"@agentproto/adapter-mastra-agent": minor
---

mastra-agent: add a workspace toolset + SQLite memory.

- **Workspace tools** — `list_dir` / `read_file` / `write_file` / `edit_file` /
  `run_command`, all confined to the session cwd with path-traversal guards.
  `run_command` is on by default; `AGENTPROTO_MASTRA_NO_EXEC=1` withholds it.
- **SQLite memory** — per-conversation memory via Mastra's LibSQL store; each ACP
  session is a memory thread. DB at `~/.agentproto/mastra-agent/memory.db`
  (override `AGENTPROTO_MASTRA_MEMORY_DB`); tuned by the AGENT.md `memory:` block.
- **Fix** — the AGENT.md markdown body is now passed as the agent's instructions
  (previously fell back to `description`).
