---
"@agentproto/runtime": minor
---

New daemon tool `session_labels`: session ids in (1 to 100, a bare id or `session:<fp>:<id>`), `{id, label?, operatorLabel?, adapter?, state?}` out, one row per id in input order, and nothing else (no cwd, prompt, model or path). An unknown id gives `{id}` alone. It is read-only and cheap, so an app UI can list it in `ui.tools` to show an agent's name without being handed `session_list`. The handler checks the id bounds itself, because `app_tool_call` reaches daemon tool handlers without the input schema.
