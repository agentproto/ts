# MCP 2026-07-28 fixtures

Request and response examples copied verbatim from the 2026-07-28 specification
pages. Retrieved 2026-10-08. Each JSON file carries a `_source` field with the page.
Nothing here is invented: a shape the spec text does not show has no fixture; the contract rows built on these fixtures live in `../../mcp-modern-contract-live.test.ts`.

| File | Page |
|---|---|
| `discover-request.json`, `discover-response.json` | https://modelcontextprotocol.io/specification/2026-07-28/server/discover |
| `tools-call-request.json`, `error-32020-header-mismatch.json` | https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http |
| `error-32022-unsupported-protocol-version.json` | https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning |
| `tools-list-response.json`, `tools-call-response.json` | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |

Also read for the contract test, without a fixture of their own:

- https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching (`ttlMs`, `cacheScope` values `"public"` and `"private"`, which operations are cacheable)
- https://modelcontextprotocol.io/specification/2026-07-28/basic/index (required `_meta` fields and `-32602`, `resultType`, error-code ranges)
- https://modelcontextprotocol.io/specification/2026-07-28/schema (`UnsupportedProtocolVersionError`, `HeaderMismatchError`)

The spec index (https://modelcontextprotocol.io/llms.txt) lists no `events/*` page for 2026-07-28, so
there are no `events/list|subscribe|unsubscribe` fixtures.

The `events/stream` (push delivery) fixtures come from the Events extension text, beta, at commit `c77b8439`
(https://github.com/modelcontextprotocol/ext-events/blob/c77b84395eff0ae32f53b0516c2214fe276ed050/specification/beta/events/events.mdx).
Retrieved 2026-11-26. Each `_source` names the section anchor.

| File | Section |
|---|---|
| `events-stream-request.json` | `#request-events-stream` |
| `events-active.json`, `events-event.json`, `events-error.json`, `events-stream-result.json` | `#event-delivery` |
| `events-heartbeat.json` | `#lifecycle` |
| `events-terminated.json` | `#subscription-termination` |
