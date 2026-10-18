---
"@agentproto/knowledge": patch
---

AIP-10 `knowledge.entry/v1` and `knowledge.source/v1` now accept a `title` of up to 1000 characters (was 200), so verbatim official legal headings no longer have to be truncated. `slug`, source `id`, and `knowledge.workspace/v1`'s title are unchanged. The change comes from the vendored `KNOWLEDGE.schema.json` (spec: agentproto/agentproto#79) and the regenerated zod in `@agentproto/knowledge`; relaxing a maximum is backwards compatible, so every previously valid document stays valid.
