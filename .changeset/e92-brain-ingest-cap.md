---
"@agentproto/runtime": minor
"@agentproto/workspace-brain": minor
---

Cap what the workspace brain materializes from one session's transcript. The brain reader now refuses an `events.jsonl` larger than 32 MB before parsing and stops at 8 MB of accumulated message text while parsing; an oversized session is recorded as a durable `too-large` skip (with the measured size and ceiling) and logged once, instead of building a huge `ExportedMessage[]`. Both ceilings are configurable under `defaults.reactions.brainIngest.maxTranscriptBytes` / `maxTranscriptTextBytes`. Explicit operator exports (session transcript, conversation read/export, checkpoints) keep their uncapped behavior; only the brain reader passes ceilings. `IngestResult` / `BrainStateSkip` gain the `too-large` reason and optional size fields, and `readSession` may now return a `SkippedTranscript` result.
