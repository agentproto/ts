/**
 * Constants of the stateless "modern" MCP era (protocol 2026-07-28). One list of supported versions feeds BOTH
 * `server/discover` and the `-32022` error, so they cannot drift (the conformance suite requires
 * `error.data.supported` to be a subset of discover's `supportedVersions`).
 */
export const MODERN_PROTOCOL_VERSION = "2026-07-28"
export const DEFAULT_SUPPORTED_VERSIONS: readonly string[] = [MODERN_PROTOCOL_VERSION]

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

export const ERR_PARSE = -32700
export const ERR_INVALID_REQUEST = -32600
export const ERR_METHOD_NOT_FOUND = -32601
export const ERR_INVALID_PARAMS = -32602
export const ERR_INTERNAL = -32603
export const ERR_HEADER_MISMATCH = -32020
export const ERR_UNSUPPORTED_VERSION = -32022

/** Methods forwarded to the in-process server. Everything else is 404 `-32601` (initialize is answered separately). */
export const FORWARDED_METHODS: ReadonlySet<string> = new Set([
  "tools/list",
  "tools/call",
  "events/list",
  "events/subscribe",
  "events/unsubscribe",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
])

/** Every method this core answers: the forwarded ones plus `server/discover`, which it builds itself. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([...FORWARDED_METHODS, "server/discover"])

/** The only results that must carry `ttlMs` + `cacheScope` (spec: server/utilities/caching). */
export const CACHE_HINT_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
])

/** Methods whose request must carry an `Mcp-Name` header, and the `params` member that holds the value. */
export const NAME_HEADER_SOURCE: ReadonlyMap<string, "name" | "uri"> = new Map([
  ["tools/call", "name"],
  ["prompts/get", "name"],
  ["resources/read", "uri"],
])
