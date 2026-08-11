---
"@agentproto/runtime": minor
---

Expose live session activity phase: new read-time fields `currentPhase`, `toolCallsThisTurn`, and `secondsSinceLastActivity` track what an agent session is currently doing (thinking, tool-call, awaiting input, etc.), the distinct tool count in the current turn, and elapsed time since last activity. All fields are ephemeral—computed on every read and never persisted—following the pattern of existing fields like `processAlive`.
