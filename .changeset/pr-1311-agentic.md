---
"@agentproto/model-routing": minor
---

Initial release of `@agentproto/model-routing`, the AIP-57 MODEL-ROUTING reference implementation: packs over declared keyspaces, ordered override > env > pack layers that always report which layer won, `null` as a non-overridable capability gate, and deterministic sticky selection over chains via FNV-1a over the stable prefix. Pure per AIP-57 §7 — no I/O, no clock, no randomness.
