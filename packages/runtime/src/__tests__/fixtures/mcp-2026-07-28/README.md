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

## Conformance replay (`_conformance`)

A fixture that carries a `_conformance` array is replayed against a live `/mcp` by
`../../mcp-conformance-blackbox.test.ts` (folder discovery, file-name order: nothing is listed in the test) and
appears in `docs/mcp-conformance-matrix.md` (regenerate with `node scripts/mcp-conformance-matrix.mjs`).
A fixture without the block is skipped and counted; that is the case of every `events-*` file today. The Events
fixtures join the replay by adding the block, without editing the test.

Each case names: `case` (`positive` or `negative`), `method` (the JSON-RPC method sent), `era`, `surface`
(`gateway`, `elicitation`, `tasks`, `skills`), `capability` (what must be declared), `title`, and `expect`
(`httpStatus`, then `code` for an error or `resultType` for a result, plus optional shape checks). Optional:
`given` (a scenario the test sets up), `request` (another fixture or an inline `{ method, params }`), `set` (paths
filled with the scenario's `$vars`), `clientCapabilities`, `meta`, `headers` (`null` removes one), `caller`,
`mutate`, `repeat`, and `knownDefect` (the expected status is the one AIP-77 gives; the code answers otherwise
today). New fixtures carry `request` and `response` (the page's request and answer) where older ones carry `body`.
The 2026-07-28 pages omit `_meta` from most examples; the replay adds the required `_meta`.

Added 2026-11-27 (pages read that day):

| File | Page |
|---|---|
| `discover-request.extensions.json` | https://modelcontextprotocol.io/specification/2026-07-28/server/discover (reconstructed with the capability block of SEP-2663) |
| `elicitation-create.form.json`, `elicitation-create.url.json` | https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation |
| `input-required-result.json`, `input-required-retry.json` | https://modelcontextprotocol.io/specification/2026-07-28/server/tools (negative cases reconstructed from https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) |
| `create-task-result.json`, `tasks-get.{working,input_required,completed,failed,cancelled}.json`, `tasks-update.json`, `tasks-cancel.json`, `error-32021-missing-capability.json`, `error-32602-unknown-task.json` | https://modelcontextprotocol.io/seps/2663-tasks-extension |

`tasks-get.cancelled.json` and `tasks-cancel.json` are reconstructed from the text (the page shows no JSON for them).
Every `tasks-get.*` answer has `resultType: "complete"`: the two examples of the page's 'Task Execution Errors'
section still carry `"task"` (read 2026-11-27), which the page's own 'Task Polling' section rules out.
