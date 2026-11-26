/**
 * Constants of the stateless "modern" MCP era (protocol 2026-07-28). Accepted
 * modern versions (`DEFAULT_SUPPORTED_VERSIONS`) are kept distinct from
 * dual-era advertised versions (`GATEWAY_ADVERTISED_VERSIONS`) so a dual-era
 * gateway can advertise `2025-11-25` in `server/discover` and `-32022` without
 * accepting `2025-11-25` on the modern path.
 */
export const MODERN_PROTOCOL_VERSION = "2026-07-28"
export const LEGACY_PROTOCOL_VERSION = "2025-11-25"
export const DEFAULT_SUPPORTED_VERSIONS: readonly string[] = [MODERN_PROTOCOL_VERSION]
export const GATEWAY_ADVERTISED_VERSIONS: readonly string[] = [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION]

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
export const ERR_MISSING_CLIENT_CAPABILITY = -32021
export const ERR_UNSUPPORTED_VERSION = -32022

/** Methods that exist only in the modern era and therefore dispatch to the modern handler on `/mcp`. */
export const MODERN_ONLY_METHODS: ReadonlySet<string> = new Set(["server/discover"])

/** Methods forwarded to the in-process server. Everything else is 404 `-32601` (initialize is answered separately). */
export const FORWARDED_METHODS: ReadonlySet<string> = new Set([
  "tools/list",
  "tools/call",
  "events/list",
  "events/subscribe",
  "events/unsubscribe",
  "events/poll",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "skills/list",
  "skills/get",
])

/** Every method this core answers: the forwarded ones plus `server/discover`, which it builds itself. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([...FORWARDED_METHODS, "server/discover"])

/** The results that must carry `ttlMs` + `cacheScope` (spec: server/utilities/caching). */
export const CACHE_HINT_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  // Skills extension (beta): `skills/get` has no `Mcp-Name` header, only `resources/read` does.
  "skills/list",
  "skills/get",
])

/** Methods whose request must carry an `Mcp-Name` header, and the `params` member that holds the value. */
export const NAME_HEADER_SOURCE: ReadonlyMap<string, "name" | "uri"> = new Map([
  ["tools/call", "name"],
  // SEP-3415: every events method but `events/list` names its event type in `Mcp-Name`.
  ["events/poll", "name"],
  ["events/subscribe", "name"],
  ["events/unsubscribe", "name"],
  ["prompts/get", "name"],
  ["resources/read", "uri"],
])
