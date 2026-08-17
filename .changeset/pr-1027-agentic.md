---
"@agentproto/runtime": minor
---

Add two new chat streaming routes (`POST /sessions/:id/chat` and `POST /sessions/chat`) that map daemon transcript records into Vercel AI SDK v6 UIMessageChunk SSE format. Includes a pure record→chunk mapper with canonical fixture conformity tests, two-phase validation for existing sessions, and refactored shared spawn logic to prevent route surface drift.
