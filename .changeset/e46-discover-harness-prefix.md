---
"@agentproto/provider-kit": minor
"@agentproto/cli": minor
"@agentproto/runtime": patch
---

Adapter discovery accepts the canonical `harness-` prefix next to `adapter-` (AIP-70): `@agentproto/harness-<slug>` and `@<scope>/agentproto-harness-<slug>` packages are discovered alongside the `adapter-` spellings, the bare `@agentproto/harness` package never matches, and the `harness-` name wins on a same-slug collision.
