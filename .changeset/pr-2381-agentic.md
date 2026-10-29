---
"@agentproto/runtime": minor
"@agentproto/workspace-brain": minor
---

Cap what the workspace brain materializes from one session's transcript. The brain reader refuses an `events.jsonl` larger than 32 MB before parsing and stops at 8 MB of accumulated message text while parsing; an oversized session is recorded as a durable `too-large` skip (with the measured size and ceiling) instead of building a huge `ExportedMessage[]`. Both ceilings are configurable under `defaults.reactions.brainIngest.maxTranscriptBytes` / `maxTranscriptTextBytes`.
