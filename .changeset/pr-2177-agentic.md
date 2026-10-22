---
"@agentproto/runtime": minor
---

Corrective bump for PR #2177: beyond the reliability fixes already covered by
`.changeset/follow-sentinel-message-reliability.md` (bumped `patch`), this PR
adds new public exports from `@agentproto/runtime` — `PROTECTED_MESSAGE_KINDS`,
`isProtectedMessage`, `isNoiseMessage`, and `effectiveMessageUrgency` — via
`export * from "./session-message.js"` in `index.ts`, plus behavior changes
(blocker/question urgency upgrade, noise-first inbox eviction, the default
7-day `expiresAt` backstop on follows and session-target sentinels, and the new
`sweepWiringLifecycle` pass). Repo bump rules make added exports and behavior
changes a `minor`; combined with the committed patch changeset the release
resolves to `minor`.
