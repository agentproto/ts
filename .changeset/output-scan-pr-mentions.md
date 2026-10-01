---
"@agentproto/runtime": minor
---

PR provenance reconciler: a third, TEXTUAL attribution lane — at each executor
session's turn-end/exit, PR urls printed in the session's own ASSISTANT output
(bounded transcript-tail read, same window `session_evidence` uses) are
recorded on `SessionDescriptor.openedPrs` with adapter `"output-scan"` when no
other lane already carried them. A mention never stamps a footer or opens a
sentinel footgun by itself: dedupe is per-url (in-memory for the run,
`openedPrs` across restarts), and the lane is in-process with zero network —
it reads the session's existing events.jsonl tail only.
