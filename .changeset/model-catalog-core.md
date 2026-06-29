---
"@agentproto/model-catalog": minor
---

new package: `@agentproto/model-catalog` — a dependency-light (zod-only) unified model catalog (LLM · image · video · audio · voice) with cost dispatcher, curation, pricing, and picker.

Extracted from agentik-studio's `@agstudio/model-catalog` as the OSS core: the catalog data + pure functions live here once; downstream consumers (the agentik-studio product, the agentproto CLI) layer their own policy (billing/access/BYOK) on top. The two `@agstudio/integration-core` types (`BillingUnit`, `CostMultipliers`) are inlined into `schema/cost-units.ts`, severing the dependency.
