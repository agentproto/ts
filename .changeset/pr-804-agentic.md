---
"@agentproto/runtime": minor
---

Add WP-D structured verdict parsing for judge gates, with optional JSON-based verdict format supporting findings/severity metadata. Judge gates can now pin a custom billing profile via `access.profileRef` to avoid wallet rate-limiting. New types: `JudgeVerdict`, `VerdictSeverity`, `VerdictFinding`. New gate spec fields: `judge.access`, `judge.route`, `judge.mode`. Verdict is persisted and echoed on `policy:passed`/`policy:failed` events. Backward compatible: existing plain-text verdicts work unchanged; JSON blocks are optional.
