---
"@agentproto/runtime": major
---

Sentinel: replace `SentinelSpec.subject` with a required multi-clause `spec.match` (OR semantics across `{subject, types?}` clauses; new `singleMatch()` helper). Dedup is now applied only after delivery (at-least-once) via the new read-only `SentinelStore.isSeen`. `SentinelTarget` gains frozen (not-yet-delivered) `routine` and `webhook` variants, rejected at create time with the new `SentinelTargetNotImplementedError`. `Sentinel` records gain a persisted `terminalSubjects` list for multi-clause `until: subject_terminal` expiry.
