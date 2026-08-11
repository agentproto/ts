---
"@agentproto/runtime": minor
---

Add conversation export tool — the write side of cross-adapter transcript pivot. Enables exporting daemon session transcripts into target adapter native stores (starting with claude-code JSONL) and returning resume handles. Complements the existing read-side (`exportClaudeCodeSession`). Includes round-trip tests verifying message fidelity.
