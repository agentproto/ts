---
"@agentproto/runtime": minor
"@agentproto/transcript-fixtures": minor
"@agentproto/sentinel": patch
---

The session message envelope now carries `from.relation: "granted"` (no tree edge, an allowance or grant admitted the send) instead of `"peer"`, plus `from.agentSlug` (the sender's AIP-42 agent); `from.role` stays one more release, deprecated. Stored and exported records written with `"peer"` are still read and map to `granted`.
