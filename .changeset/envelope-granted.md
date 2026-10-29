---
"@agentproto/runtime": minor
"@agentproto/transcript-fixtures": minor
"@agentproto/sentinel": minor
---

The session message envelope now carries `from.relation: "granted"` (no tree edge, an allowance or grant admitted the send) instead of `"peer"`, plus `from.agentSlug` (the sender's AIP-42 agent); `from.role` stays one more release, deprecated.
`"peer"` stays in the relation unions as a deprecated member (never produced): stored records are read as `granted`, exported records keep the historical value. The transcript exporter does not carry `from.agentSlug` (like `from.role`/`adapter`); it stays on the live/stored envelope. `@agentproto/sentinel` mirrors both changes, so it is a minor bump.
