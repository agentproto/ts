---
"@agentproto/runtime": patch
---

A restarted session that could not resume natively (a box restart — re-attach
to a live box or a fresh box after the old one died — or a local blank
fallback) now gets the FULL prior conversation instead of a 7k-char digest.
On every box restart the prior session's daemon transcript is exported to
Markdown (tool bodies capped at 2000 chars) and written into the box at
`/home/user/.agentproto/prior-sessions/<sessionId>.md` (ancestors of a
restart chain too, up to 5 hops; via the host's `writeFile` or base64 chunks
over `exec`). The injected first-turn context is a structured handoff — a
frame stating what happened / what was restored / what was lost, a
deterministic-extractor checkpoint (`renderCheckpointPrompt`, no LLM handoff
turn: the prior agent is dead), the most recent turns (~24k chars), and the
transcript path(s) with an instruction to read them before redoing anything).
Local blank-fallback restarts write the transcript into the new session's
host dir and get the same frame; the old `buildResumeContextDigest` stays as
the fallback when the export or write fails, and a handoff failure never
fails the restart. Restart results now carry
`handoff: { transcriptPath, checkpointId, recentChars, totalMessages }` so
CLI/VS Code/session-chat can say "conversation restored from transcript
(N messages)".
