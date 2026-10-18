---
"@agentproto/knowledge": patch
"@agentproto/corpus-cli": patch
---

AIP-10 `knowledge.entry/v1` and `knowledge.source/v1` now accept a `title` of up to 1000 characters (was 200), so verbatim official legal headings no longer have to be truncated. `slug` and source `id` stay at 96. The change comes from the vendored `KNOWLEDGE.schema.json` (spec: agentproto/agentproto#79) and the regenerated zod in `@agentproto/knowledge`; `@agentproto/corpus-cli` bundles the schema at build, so `validate` / `lint` pick it up on its next publish. Relaxing a maximum is backwards compatible: every previously valid document stays valid.
