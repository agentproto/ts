---
"@agentproto/runtime": patch
---

Extract a `SessionObserver` seam so the per-session transcript tap is pluggable.
`sessions.ts` now fans prompt/event/usage/close calls out through
`composeSessionObservers([...])` with the transcript writer as the sole member —
behaviour is identical (fan-out over one). Additional observers (e.g. an opt-in
Langfuse session tracer) can attach without touching the turn loop. Member calls
are isolated so a failing observer can neither break siblings nor throw a turn.
