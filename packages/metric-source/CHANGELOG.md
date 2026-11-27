# @agentproto/metric-source

## 0.2.0

### Minor Changes

- da79225: Add `collectionSpec` / `collectionVerbs` to `@agentproto/collection`, add `toFrontmatter` to `toolSpec` in `@agentproto/tool` so snake_case frontmatter keys and Zod IO schemas survive round-trips, and introduce `@agentproto/metric-source` with `defineMetricSource` and a bijective TypeScript <-> Markdown manifest converter verified against all four real AIP parsers.

### Patch Changes

- Updated dependencies [da79225]
  - @agentproto/collection@0.3.0
  - @agentproto/tool@0.8.0
  - @agentproto/driver@0.4.4
