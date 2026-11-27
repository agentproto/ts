import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { BridgeError, forwardParams, openBridge, type Bridge } from "./bridge.js"
import {
  ALLOWED_METHODS,
  CACHE_HINT_METHODS,
  DEFAULT_SUPPORTED_VERSIONS,
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_MISSING_CLIENT_CAPABILITY,
  EVENTS_STREAM_METHOD,
  META_CLIENT_CAPABILITIES,
  TASK_EXTENSION_METHODS,
  META_SERVER_INFO,
} from "./constants.js"
import {
  acceptsEventStream,
  acceptsJson,
  isJsonContentType,
  normalizeHeaders,
  parseBody,
  validateRequest,
  type ModernError,
  type ParsedRequest,
  type RawHeaders,
} from "./validate.js"

export * from "./constants.js"
export * from "./mrtr-state.js"
export * from "./human-gate.js"
export * from "./tasks.js"
export { forwardParams } from "./bridge.js"
export { decodeHeaderValue, isJsonContentType, normalizeHeaders, type ParsedRequest } from "./validate.js"
import type { HumanGate } from "./human-gate.js"
import { runWithTurnTaskReservation } from "../turn-task-context.js"
import { TASKS_EXTENSION, clientDeclaresTasks, handleTaskRequest, type TaskProjector } from "./tasks.js"

export function extractClientCapabilities(req: ParsedRequest): Record<string, unknown> | undefined {
  const meta = req.params._meta
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined
  const caps = (meta as Record<string, unknown>)[META_CLIENT_CAPABILITIES]
  return typeof caps === "object" && caps !== null && !Array.isArray(caps) ? (caps as Record<string, unknown>) : undefined
}

export interface ModernRequestInput {
  /** HTTP verb. */
  method: string
  headers: RawHeaders
  /** Raw body text, already size-capped by the caller. */
  body: string
}

/** Where an `events/stream` response writes its SSE frames (one JSON-RPC message per frame). */
export interface ModernStreamSink {
  /** Resolves once the message is written (after `drain` when the socket buffered); rejects on a dead socket. */
  send(message: Record<string, unknown>): Promise<void>
  /** Aborted when the HTTP client goes away. */
  signal: AbortSignal
  /** Aborted when the server shuts down: the stream writes its final frame and ends. */
  closing?: AbortSignal
}

/** `closed`: ended by the server after its final frame; `aborted`: client gone; `stalled`: drop the connection. */
export type ModernStreamOutcome = "closed" | "aborted" | "stalled"

/** Writes the stream until it ends. The transport MUST call it exactly once: it releases what the open reserved. */
export type ModernStream = (sink: ModernStreamSink) => Promise<ModernStreamOutcome>

/**
 * `events/stream` (Events extension, push delivery). `open` validates and reserves; a throw carrying a numeric
 * `code` (and optional `data`) is answered as a plain JSON-RPC error, before any SSE frame.
 */
export interface EventsStreamHandler {
  open(request: { id: string | number; params: Record<string, unknown> }): Promise<ModernStream>
}

export interface ModernResponse {
  status: number
  headers: Record<string, string>
  body?: string
  /** Set for an SSE response (`events/stream`): the transport writes the SSE head, then runs it. No `body`. */
  stream?: ModernStream
}

export interface CacheHints {
  ttlMs: number
  cacheScope: "public" | "private"
}

export interface ModernDeps {
  /** Build a FRESH legacy server for this one request (same factory, same query scoping as the legacy path). */
  createServer: () => Promise<McpServer>
  /**
   * Protocol versions ACCEPTED by the modern request validator.
   * Defaults to `supportedVersions` or `["2026-07-28"]`.
   */
  protocolVersions?: readonly string[]
  /**
   * Protocol versions ADVERTISED in `server/discover` (`result.supportedVersions`)
   * and `-32022` (`error.data.supported`). Defaults to `protocolVersions`.
   */
  advertisedVersions?: readonly string[]
  /** Shorthand for setting both `protocolVersions` and `advertisedVersions`. */
  supportedVersions?: readonly string[]
  /** Hints for the six cacheable operations. Default: `{ ttlMs: 0, cacheScope: "private" }` (never cached). */
  cachePolicy?: (method: string) => CacheHints
  /** Entries merged into `capabilities.extensions` in `server/discover`. */
  extensions?: Record<string, Record<string, unknown>>
  /** Extract client capabilities from a parsed modern request. */
  clientCapabilitiesOf?: (req: ParsedRequest) => Record<string, unknown> | undefined
  /** Optional MRTR elicitation gate for parked permissions and session questions. */
  humanGate?: HumanGate
  /**
   * Tasks extension (one session turn projected as a task). Absent = disabled: `server/discover` does not announce it,
   * `tasks/*` answer `-32601` and `agent_start` / `agent_prompt` answer as before.
   */
  tasks?: TaskProjector
  /**
   * Events extension push delivery. Absent = disabled: `events/stream` is not in the allowed set and answers 404
   * `-32601`. Answered here, before the in-process bridge opens (the bridge drops server messages without an id).
   */
  eventsStream?: EventsStreamHandler
  /** Resolved caller session id (absent for the operator), passed to `humanGate`. */
  callerSessionId?: string
  /** Called for `server/discover` and `tools/list` with the JSON-RPC response sent back (feeds the observer). */
  onObserved?: (method: "server/discover" | "tools/list", response: Record<string, unknown>) => void
  /** Aborted when the HTTP client disconnects; the in-process request is cancelled. */
  signal?: AbortSignal
}

const DEFAULT_CACHE_POLICY = (): CacheHints => ({ ttlMs: 0, cacheScope: "private" })

const JSON_HEADERS = { "content-type": "application/json" }

function errorResponse(error: ModernError, extraHeaders: Record<string, string> = {}): ModernResponse {
  return {
    status: error.status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: error.id,
      error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) },
    }),
  }
}

function okResponse(id: string | number, result: Record<string, unknown>): ModernResponse {
  return { status: 200, headers: { ...JSON_HEADERS }, body: JSON.stringify({ jsonrpc: "2.0", id, result }) }
}

/** `resultType`, the server info in `_meta`, and the cache hints on the six operations that must carry them. */
function decorate(
  method: string,
  result: Record<string, unknown>,
  serverInfo: { name: string; version: string },
  hints: CacheHints,
): Record<string, unknown> {
  const meta =
    typeof result._meta === "object" && result._meta !== null && !Array.isArray(result._meta)
      ? (result._meta as Record<string, unknown>)
      : {}
  const resultType = typeof result.resultType === "string" ? result.resultType : "complete"
  const decorated: Record<string, unknown> = {
    ...result,
    resultType,
    _meta: { ...meta, [META_SERVER_INFO]: meta[META_SERVER_INFO] ?? serverInfo },
  }
  if (resultType === "complete" && CACHE_HINT_METHODS.has(method)) {
    decorated.ttlMs = typeof result.ttlMs === "number" ? result.ttlMs : hints.ttlMs
    decorated.cacheScope = typeof result.cacheScope === "string" ? result.cacheScope : hints.cacheScope
  }
  return decorated
}

/** A Skills request (beta extension): `skills/list`, `skills/get`, or a `resources/read` of a `skill://` URI. */
function isSkillsRequest(method: string, params: Record<string, unknown>): boolean {
  if (method === "skills/list" || method === "skills/get") return true
  // A URI scheme is case-insensitive (RFC 3986 3.1): `SKILL://` is a Skills read too.
  return method === "resources/read" && typeof params.uri === "string" && /^skill:\/\//i.test(params.uri)
}

/**
 * The Skills errors are `McpError`s raised inside the in-process server, so they cross the bridge without an HTTP
 * status. Their invalid params (unknown skill or file, bad cursor, traversal) are answered with HTTP 400 (AIP-77
 * "Error mapping"); any other code keeps its default.
 */
function asSkillsError(error: unknown): unknown {
  return error instanceof BridgeError && error.code === ERR_INVALID_PARAMS && error.httpStatus === undefined
    ? new BridgeError(error.code, error.message, error.data, 400)
    : error
}

function fromThrown(error: unknown, id: string | number): ModernResponse {
  if (error instanceof BridgeError) {
    // `McpError` serializes its message with an "MCP error <code>: " prefix; strip it (possibly repeated).
    const message = error.message.replace(/^(?:MCP error -?\d+: )+/, "")
    // An unknown method is 404, a missing required client capability (-32021) is 400 (spec basic/index).
    // Any other JSON-RPC error raised by a handler keeps HTTP 200, as the legacy transport answers it.
    const status =
      error.httpStatus !== undefined
        ? error.httpStatus
        : error.code === ERR_METHOD_NOT_FOUND
        ? 404
        : error.code === ERR_MISSING_CLIENT_CAPABILITY
          ? 400
          : 200
    return errorResponse({ status, code: error.code, message, id, ...(error.data !== undefined ? { data: error.data } : {}) })
  }
  return errorResponse({ status: 500, code: ERR_INTERNAL, message: "Internal error", id })
}

async function answer(
  request: ParsedRequest & { id: string | number },
  bridge: Bridge,
  advertised: readonly string[],
  deps: ModernDeps,
  hints: CacheHints,
): Promise<Record<string, unknown>> {
  if (request.method === "server/discover") {
    const capabilities: Record<string, unknown> = { ...bridge.capabilities }
    delete capabilities.logging // removed in the modern era
    // `listChanged` promises list-change notifications, which the modern era delivers over
    // `subscriptions/listen`. That method is not served here (it answers 404), so the flag is withdrawn.
    for (const key of ["tools", "resources", "prompts"] as const) {
      const entry = capabilities[key]
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && "listChanged" in entry) {
        const rest: Record<string, unknown> = { ...(entry as Record<string, unknown>) }
        delete rest.listChanged
        capabilities[key] = rest
      }
    }
    if (deps.extensions !== undefined || deps.tasks !== undefined) {
      const existing =
        typeof capabilities.extensions === "object" &&
        capabilities.extensions !== null &&
        !Array.isArray(capabilities.extensions)
          ? (capabilities.extensions as Record<string, unknown>)
          : {}
      capabilities.extensions = {
        ...existing,
        ...(deps.extensions ?? {}),
        ...(deps.tasks ? { [TASKS_EXTENSION]: {} } : {}),
      }
    }
    return decorate(
      "server/discover",
      {
        supportedVersions: [...advertised],
        capabilities,
        ...(bridge.instructions ? { instructions: bridge.instructions } : {}),
      },
      bridge.serverInfo,
      hints,
    )
  }

  const forward = () => bridge.request(request.method, forwardParams(request.params), deps.signal)
  const clientCapabilities = (deps.clientCapabilitiesOf ?? extractClientCapabilities)(request)

  if (deps.tasks && TASK_EXTENSION_METHODS.includes(request.method)) {
    const result = await handleTaskRequest(deps.tasks, {
      method: request.method,
      params: request.params,
      ...(deps.callerSessionId !== undefined ? { callerSessionId: deps.callerSessionId } : {}),
      ...(clientCapabilities !== undefined ? { clientCapabilities } : {}),
    })
    return decorate(request.method, result, bridge.serverInfo, hints)
  }

  if (request.method === "tools/call" && (deps.humanGate || deps.tasks)) {
    const tool = typeof request.params.name === "string" ? request.params.name : ""
    const gated = deps.humanGate
      ? () =>
          deps.humanGate!.handleToolCall(
            {
              tool,
              params: request.params,
              ...(deps.callerSessionId !== undefined ? { callerSessionId: deps.callerSessionId } : {}),
              ...(clientCapabilities !== undefined ? { clientCapabilities } : {}),
            },
            forward,
          )
      : forward
    // The server decides to create a task, never the client: only for a client that declared the extension.
    // The host reserves the ticket (and, for agent_start, the session id) BEFORE the tool runs and hands it over
    // through a request-scoped context, so the task is recorded durably before the session hears of the prompt.
    const plan =
      deps.tasks && clientDeclaresTasks(clientCapabilities)
        ? deps.tasks.plan(tool, request.params, deps.callerSessionId)
        : undefined
    if (plan?.kind === "refused") return decorate(request.method, plan.answer, bridge.serverInfo, hints)
    const rawResult = plan ? await runWithTurnTaskReservation(plan.reservation, gated) : await gated()
    const answer = plan && deps.tasks ? deps.tasks.finalize(plan, rawResult) : rawResult
    return decorate(request.method, answer, bridge.serverInfo, hints)
  }

  if (isSkillsRequest(request.method, request.params)) {
    let result: Record<string, unknown>
    try {
      result = await forward()
    } catch (error) {
      throw asSkillsError(error)
    }
    return decorate(request.method, result, bridge.serverInfo, hints)
  }

  return decorate(request.method, await forward(), bridge.serverInfo, hints)
}

const SSE_RESPONSE_HEADERS = { "content-type": "text/event-stream" }

async function openStream(
  handler: EventsStreamHandler,
  request: { id: string | number; params: Record<string, unknown> },
  accept: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ModernResponse> {
  if (!acceptsEventStream(accept)) {
    return errorResponse({
      status: 406,
      code: ERR_INVALID_REQUEST,
      message: "Accept must allow text/event-stream for events/stream",
      id: request.id,
    })
  }
  let stream: ModernStream
  try {
    stream = await handler.open(request)
  } catch (error) {
    if (signal?.aborted) return { status: 499, headers: {} }
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === "number" && Number.isInteger(code)) {
      const data = (error as { data?: unknown }).data
      return errorResponse({
        status: 200,
        code,
        message: error instanceof Error ? error.message : "Error",
        id: request.id,
        ...(data !== undefined ? { data } : {}),
      })
    }
    return errorResponse({ status: 500, code: ERR_INTERNAL, message: "Internal error", id: request.id })
  }
  return { status: 200, headers: { ...SSE_RESPONSE_HEADERS }, stream }
}

/**
 * Serve ONE modern-era HTTP request without touching the network layer. Order: verb, Accept, Content-Type, body,
 * notification (202), request validation, in-process bridge. Never throws.
 */
export async function handleModernRequest(input: ModernRequestInput, deps: ModernDeps): Promise<ModernResponse> {
  const accepted = deps.protocolVersions ?? deps.supportedVersions ?? DEFAULT_SUPPORTED_VERSIONS
  const advertised = deps.advertisedVersions ?? accepted
  const cachePolicy = deps.cachePolicy ?? DEFAULT_CACHE_POLICY
  const headers = normalizeHeaders(input.headers)

  if (input.method !== "POST") {
    return errorResponse({ status: 405, code: ERR_INVALID_REQUEST, message: "Only POST is supported", id: null }, { allow: "POST" })
  }
  if (!acceptsJson(headers["accept"])) {
    return errorResponse({ status: 406, code: ERR_INVALID_REQUEST, message: "Accept must allow application/json", id: null })
  }
  if (!isJsonContentType(headers["content-type"])) {
    return errorResponse({ status: 415, code: ERR_INVALID_REQUEST, message: "Content-Type must be application/json", id: null })
  }
  const parsed = parseBody(input.body)
  if (!parsed.ok) return errorResponse(parsed.error)
  const request = parsed.request
  // No client-to-server notification exists in the modern core: accept and ignore (202, no body).
  if (request.id === undefined) return { status: 202, headers: {} }
  const allowed =
    deps.tasks || deps.eventsStream
      ? new Set([
          ...ALLOWED_METHODS,
          ...(deps.tasks ? TASK_EXTENSION_METHODS : []),
          ...(deps.eventsStream ? [EVENTS_STREAM_METHOD] : []),
        ])
      : ALLOWED_METHODS
  const invalid = validateRequest(request, headers, accepted, allowed, advertised)
  if (invalid) return errorResponse(invalid)

  const id = request.id
  // `events/stream` is answered BEFORE the bridge opens: the bridge keeps only replies to its own requests, and a
  // stream is a run of notifications plus an optional final frame. No `decorate`: the final frame carries no
  // `ttlMs`, `cacheScope` or `serverInfo`.
  if (request.method === EVENTS_STREAM_METHOD && deps.eventsStream) {
    return openStream(deps.eventsStream, { id, params: request.params }, headers["accept"], deps.signal)
  }
  let bridge: Bridge | undefined
  try {
    bridge = await openBridge(await deps.createServer())
    const result = await answer(
      { ...request, id },
      bridge,
      advertised,
      deps,
      cachePolicy(request.method),
    )
    if (deps.signal?.aborted) return { status: 499, headers: {} }
    const response = okResponse(id, result)
    if ((request.method === "server/discover" || request.method === "tools/list") && deps.onObserved) {
      try {
        deps.onObserved(request.method, { jsonrpc: "2.0", id, result })
      } catch {
        // observation must never break the request
      }
    }
    return response
  } catch (error) {
    if (deps.signal?.aborted) return { status: 499, headers: {} }
    const response = fromThrown(error, id)
    if ((request.method === "server/discover" || request.method === "tools/list") && deps.onObserved && response.body) {
      try {
        deps.onObserved(request.method, JSON.parse(response.body) as Record<string, unknown>)
      } catch {
        // observation must never break the request
      }
    }
    return response
  } finally {
    await bridge?.close()
  }
}
