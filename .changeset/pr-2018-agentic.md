---
"@agentproto/runtime": patch
---

Fix a stale comment in `decision-policy.ts` that still claimed there was no AIP for decision policies; AIP-65 (DECISION.md) specifies this file's contract. Also adds a `check-aip-refs` CI gate (script + tests) that fails on dangling `AIP-<N>` references and warns on stale "no AIP" claims against the pinned canonical registry. No runtime behavior change.
