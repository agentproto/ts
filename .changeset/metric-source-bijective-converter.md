---
"@agentproto/collection": minor
"@agentproto/tool": minor
"@agentproto/metric-source": minor
---

Add `collectionSpec` / `collectionVerbs` to `@agentproto/collection`, add `toFrontmatter` to `toolSpec` in `@agentproto/tool` so snake_case frontmatter keys and Zod IO schemas survive round-trips, and introduce `@agentproto/metric-source` with `defineMetricSource` and a bijective TypeScript <-> Markdown manifest converter verified against all four real AIP parsers.
