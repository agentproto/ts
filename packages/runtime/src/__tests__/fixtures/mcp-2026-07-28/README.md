# MCP 2026-07-28 fixtures

Request and response examples copied verbatim from the 2026-07-28 specification
pages. Retrieved 2026-10-08. Each JSON file carries a `_source` field with the page.
Nothing here is invented: a shape the spec text does not show has no fixture and is a
`test.todo` in `../../mcp-modern-contract.test.ts`.

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
