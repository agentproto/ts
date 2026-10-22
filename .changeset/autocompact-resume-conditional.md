---
"@agentproto/runtime": patch
---

Autocompact: the resume prompt now fires only when there is real work in progress, and the full transcript pointer survives the compaction.

Two fixes to the autocompact path (`contextContinuity.autoCompactAtTokens`):

- Resume: the short resume prompt is injected after an automatic compaction ONLY when the session really had work in progress at the moment of the compaction, read from the runtime state captured BEFORE the `/compact` prompt went out: a background task outstanding, a tool call still unanswered (or a parked permission request), or a last turn that ended on an error or an interruption. A user stop (`cancelled`) and a session parked on an unanswered question are NOT work in progress: resuming would restart what the user stopped, or drop the pending question. The session title and the checkpoint's goal are NEVER the trigger. The checkpoint's goal section falls back to the session title, so the goal-based rule fired on essentially every session and spent a turn (and a model call) to wake an idle agent that had nothing to resume. The goal survives only as optional text inside the resume prompt.
- Transcript lookup: the compaction always carries the path of the full transcript and a reminder that `transcript_search` / `transcript_read` exist, so the session can recover whatever the summary dropped. A harness whose compact command takes an argument (claude-code: `/compact <instructions>`) gets it on the command itself; for every other harness the same one-line reminder rides along with the NEXT prompt the session receives, exactly once, and never as a turn of its own. The resume prompt cites the path and the two tools too.
