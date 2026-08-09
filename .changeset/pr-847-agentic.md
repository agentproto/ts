---
agentproto-vscode: minor
---

Enhance session search to use token-AND semantics: each whitespace-separated token in the query must appear (case-insensitive substring) in the session's label, command, cwd, or id. Query tokens are independent of order, and an empty or whitespace-only query matches all sessions. This provides a better UX for multi-word searches (e.g., "build sales" now returns sessions matching both "build" AND "sales", not just the literal phrase).
