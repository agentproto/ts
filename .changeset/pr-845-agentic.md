---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add prompt provenance tracking to transcript records and webview, enabling accurate attribution of supervisor-orchestrated turns. When one agent session prompts another (via `agent_prompt` or spawn with `initialPrompt`), the originating session ID is now recorded as the turn's source and displayed in the conversation UI as "SUPERVISOR ASKED" instead of "YOU ASKED". The feature is backward-compatible: existing transcripts and API call sites are unaffected, and source fields are optional everywhere.
