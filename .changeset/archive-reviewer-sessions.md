---
"@agentproto/runtime": patch
---

Archive one-shot reviewer sessions once their review lane finishes (success, failure, timeout, abort and each retry attempt) so they stop piling up in the session list; the transcript and verdict stay readable. Add `POST /sessions/:id/archive`, the HTTP twin of the `session_archive` MCP verb (404 unknown session, 409 `session_not_terminal` while the session is still running), so HTTP clients can archive their own throwaway sessions.
