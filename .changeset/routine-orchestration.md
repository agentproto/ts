---
"@agentproto/runtime": minor
---

Routine runner, orchestration tools, session event bus, event ring, transcript export.

Adds `RoutineRunner` for scheduled / event-triggered routine execution, `SessionEventBus` for typed intra-session pub-sub, `EventRing` as a bounded circular buffer for session events, `orchestration-tools` (run-routine, list-routines AIP tools), and `exportTranscript` for full-session transcript serialisation. Also extends `sessions.ts` with `awaitingInput` state and browser-session fields (non-breaking additions).
