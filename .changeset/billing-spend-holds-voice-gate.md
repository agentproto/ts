---
"@agentproto/billing": minor
"@agentproto/voice": minor
---

Add `@agentproto/billing/spend` (`createHolds`: reserve before a metered action, settle at the real cost capped to the reserve, release on failure, sweep the holds a crash left open, all idempotent by key, on the AIP-49 `reserve`/`capture`/`release` verbs) and `guardVoiceCall` in `@agentproto/voice` (authorize before the call opens, poll a balance checkpoint with warn and cutoff, settle in a `finally`).

Both packages export contract tests from `/testing` (`holdsConformanceCases`, `voiceBillingGateConformanceCases`) that a host overlay runs on every upgrade.
