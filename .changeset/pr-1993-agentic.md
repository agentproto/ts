---
"@agentproto/runtime": patch
---

Route every session-addressing MCP tool through the shared `resolveSessionRef` + `sessionRefSchema` so `sessionId`, `idOrName`, and `slug` are all accepted uniformly across the session surface (previously each tool declared only one of the spellings), with a transport-level regression test in `session-ref-keys.test.ts`.
