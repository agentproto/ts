---
"@agentproto/runtime": minor
---

Expose `origin` on the compact `session_list` rows and `wrapupFlag` on the session summary. Both are already on the session descriptor; surfacing them in the summary/compact projections lets UIs (session tree grouping, session-steward) read them without opting into `full: true`.
