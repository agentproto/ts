# @agentproto/metric-source

Bijective TypeScript <-> Markdown converter and Zod v4 schemas for declarative, read-only metric sources.

Neither representation is authoritative:

- `defineMetricSource(spec)` validates and freezes a `MetricSourceSpec`.
- `sourceToManifests(spec)` converts a spec into standard AIP manifests (`TOOL.md`, `DRIVER.md`, `ROUTINE.md`, and optionally `COLLECTION.md`).
- `manifestsToSource(bundle)` parses those manifests with the real AIP parsers (`@agentproto/tool`, `@agentproto/driver`, `@agentproto/routine`, `@agentproto/collection`) and reconstructs the identical `MetricSourceSpec` with explicit warnings if non-AIP metadata was omitted.
- `renderSourceTs(spec)` renders a standalone TypeScript `SOURCE.ts` declaration.
- `writeSourceBundle(spec, dir)` writes the bundle atomically via `updateManifestSet`.
- `loadSource(dir, sourceId)` loads a bundle from disk back into a validated `MetricSourceSpec`.

Each field lives in a single canonical location (no sidecar JSON file), and authentication headers are never duplicated inside `metadata.http.defaultHeaders`.
