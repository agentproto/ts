/**
 * `@agentproto/app-client` — framework-free typed client for the
 * `window.McpApp` bridge an agentproto host injects into an app's UI.
 *
 * An app's UI is a static bundle that can run in three places, and this
 * module's whole job is making `connectMcpApp()` behave identically in all
 * three without the app author branching on where it's running:
 *
 *   1. "host" — embedded in an MCP-Apps panel, or served by
 *      `agentproto app serve` (which injects a `window.McpApp` bridge script
 *      whose `callTool` proxies to the daemon's `/mcp` endpoint — see
 *      `packages/cli/src/app-serve.ts`'s `buildBridgeScript`). `window.McpApp`
 *      exists, so we use it directly.
 *
 *   2. "bridge" — `agentproto app dev`'s plain `vite dev` server, which has
 *      no injected `window.McpApp` but does proxy a same-origin
 *      `POST /__agentproto/tool-call` route to the daemon. We construct the
 *      connection optimistically in this mode (no upfront network probe —
 *      the frozen contract forbids one) and only find out whether the route
 *      is really there on the first `callTool`.
 *
 *   3. "standalone" — a bare `vite dev`/`vite preview`/`file://` open with
 *      no bridge at all (e.g. a UI developer iterating without the daemon
 *      running). The first `callTool`'s network failure/404/non-JSON
 *      response flips the connection permanently to standalone and replays
 *      that call against caller-supplied mock handlers — the graceful floor
 *      so a UI never hard-fails just because nothing is listening.
 *
 * `connectMcpApp()` never throws for a *missing* host — standalone is always
 * reachable. It can still reject if a *present* `window.McpApp`'s `connect()`
 * itself rejects (a broken host is a real error, not something to paper
 * over).
 */

/** The object the daemon/panel injects as `window.McpApp`. */
export interface McpAppGlobal {
  connect(): Promise<McpAppBridge>
}

export interface McpAppBridge {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>
  updateModelContext(ctx: Record<string, unknown>): Promise<unknown>
  openLink(url: string): Promise<unknown>
  onTeardown(cb: () => void): void
}

export type McpConnectionMode = "host" | "bridge" | "standalone"

/** Result envelope of an MCP tools/call — the wire shape callTool unwraps. */
export interface McpToolResultEnvelope {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: ReadonlyArray<{ type: string; text?: string }>
}

export class McpToolError extends Error {
  readonly toolName: string
  readonly mode: McpConnectionMode
  /** Concatenated text content of the error result, if any. */
  readonly detail?: string

  constructor(toolName: string, mode: McpConnectionMode, detail?: string) {
    super(`MCP tool "${toolName}" failed in ${mode} mode${detail ? `: ${detail}` : ""}`)
    this.name = "McpToolError"
    this.toolName = toolName
    this.mode = mode
    this.detail = detail
  }
}

export type StandaloneToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown

export interface ConnectOptions {
  /** Same-origin POST route probed when window.McpApp is absent.
   *  Default "/__agentproto/tool-call" (matches `app serve` and the
   *  `app dev` proxy). */
  bridgeRoute?: string
  /** Mock tool handlers for standalone mode (plain `vite dev`, file://).
   *  A called tool with no handler rejects with McpToolError. */
  standaloneTools?: Readonly<Record<string, StandaloneToolHandler>>
}

export interface McpConnection {
  readonly mode: McpConnectionMode
  /** Typed unwrap of an MCP call: envelope.isError → reject McpToolError;
   *  structuredContent → returned; else first text content JSON.parse'd
   *  when parseable, else the raw text; no content → undefined-ish record.
   *  Caller supplies the expected shape via the type parameter and a
   *  runtime narrowing is NOT performed (documented). */
  callTool<TResult>(name: string, args?: Record<string, unknown>): Promise<TResult>
  updateModelContext(ctx: Record<string, unknown>): Promise<void>
  openLink(url: string): Promise<void>
  onTeardown(cb: () => void): void
  /** Fires once if the connection downgrades bridge → standalone. */
  onModeChange(cb: (mode: McpConnectionMode) => void): void
}

declare global {
  interface Window {
    McpApp?: McpAppGlobal
  }
}

const DEFAULT_BRIDGE_ROUTE = "/__agentproto/tool-call"

/**
 * Unwrap a raw MCP `tools/call` result (shape: {@link McpToolResultEnvelope})
 * per the frozen rule: `isError` rejects, `structuredContent` wins over
 * `content`, a single text content block is JSON-parsed when possible, and
 * an empty/missing content list resolves to `{}`. The generic cast at the
 * end is intentional and documented on `McpConnection.callTool` — the caller
 * asserts the shape, this function does not verify it at runtime.
 */
function unwrapEnvelope<TResult>(
  raw: unknown,
  toolName: string,
  mode: McpConnectionMode,
): TResult {
  const envelope = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>

  if (envelope.isError === true) {
    throw new McpToolError(toolName, mode, extractTextDetail(envelope))
  }

  const structuredContent = envelope.structuredContent
  if (typeof structuredContent === "object" && structuredContent !== null) {
    return structuredContent as TResult
  }

  const content = envelope.content
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as Record<string, unknown> | undefined
    const text = first?.text
    if (typeof text === "string") {
      try {
        return JSON.parse(text) as TResult
      } catch {
        return text as unknown as TResult
      }
    }
  }

  return {} as TResult
}

/** Concatenate every text content block's `text`, for an error's `detail`. */
function extractTextDetail(envelope: Record<string, unknown>): string | undefined {
  const content = envelope.content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .map((item) =>
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>).text
        : undefined,
    )
    .filter((text): text is string => typeof text === "string")
  return texts.length > 0 ? texts.join("\n") : undefined
}

/** Extract `.message` from an error body shaped like `app-serve`'s
 *  `callDaemonTool` failure responses (`{ error, message }`). */
function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const message = (body as Record<string, unknown>).message
  return typeof message === "string" ? message : undefined
}

async function standaloneCall<TResult>(
  standaloneTools: Readonly<Record<string, StandaloneToolHandler>>,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<TResult> {
  const handler = standaloneTools[name]
  if (!handler) {
    throw new McpToolError(name, "standalone", `no standalone handler registered for tool "${name}"`)
  }
  const result = await handler(args ?? {})
  return result as TResult
}

/** A resolved `fetch` to the bridge route: either a usable envelope, or a
 *  signal that the route isn't really there (triggers the standalone
 *  downgrade). A real HTTP error from an existing route (e.g. the daemon
 *  being unreachable) throws directly instead — that's not a missing
 *  bridge, it's a failed call. */
async function fetchBridgeEnvelope(
  bridgeRoute: string,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<{ downgrade: true } | { downgrade: false; envelope: unknown }> {
  let res: Response
  try {
    res = await fetch(bridgeRoute, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, args: args ?? {} }),
    })
  } catch {
    return { downgrade: true }
  }
  if (res.status === 404) return { downgrade: true }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { downgrade: true }
  }

  if (!res.ok) {
    throw new McpToolError(name, "bridge", extractErrorMessage(body) ?? `HTTP ${res.status}`)
  }
  return { downgrade: false, envelope: body }
}

/** `mode: "host"` connection — a thin pass-through to the injected/panel
 *  bridge. Host mode is terminal: it never downgrades. */
function createHostConnection(bridge: McpAppBridge): McpConnection {
  return {
    mode: "host",
    async callTool<TResult>(name: string, args?: Record<string, unknown>): Promise<TResult> {
      const raw = await bridge.callTool(name, args ?? {})
      return unwrapEnvelope<TResult>(raw, name, "host")
    },
    async updateModelContext(ctx: Record<string, unknown>): Promise<void> {
      await bridge.updateModelContext(ctx)
    },
    async openLink(url: string): Promise<void> {
      await bridge.openLink(url)
    },
    onTeardown(cb: () => void): void {
      bridge.onTeardown(cb)
    },
    onModeChange(): void {
      // Host mode is terminal — nothing to notify about, ever.
    },
  }
}

/** `mode: "bridge"` connection that can downgrade to `"standalone"` on the
 *  first `callTool`. Once the first call resolves — either confirming the
 *  bridge route is real, or downgrading — that outcome is permanent. */
function createFallbackConnection(
  bridgeRoute: string,
  standaloneTools: Readonly<Record<string, StandaloneToolHandler>>,
): McpConnection {
  let mode: McpConnectionMode = "bridge"
  let bridgeConfirmed = false
  const modeChangeListeners: Array<(mode: McpConnectionMode) => void> = []

  function downgradeToStandalone(): void {
    if (mode === "standalone") return
    mode = "standalone"
    for (const cb of modeChangeListeners) cb("standalone")
  }

  async function callTool<TResult>(name: string, args?: Record<string, unknown>): Promise<TResult> {
    if (mode === "standalone") {
      return standaloneCall<TResult>(standaloneTools, name, args)
    }

    const outcome = await fetchBridgeEnvelope(bridgeRoute, name, args)
    if (outcome.downgrade) {
      if (!bridgeConfirmed) {
        downgradeToStandalone()
        return standaloneCall<TResult>(standaloneTools, name, args)
      }
      // A previously-confirmed bridge suddenly looking unreachable is a real
      // failure, not a fresh "there's no bridge at all" signal — don't
      // re-downgrade a connection that already proved itself.
      throw new McpToolError(name, "bridge", "bridge route became unavailable (404/non-JSON response)")
    }

    bridgeConfirmed = true
    return unwrapEnvelope<TResult>(outcome.envelope, name, "bridge")
  }

  return {
    get mode(): McpConnectionMode {
      return mode
    },
    callTool,
    async updateModelContext(): Promise<void> {
      // No host to persist model context with in bridge/standalone modes —
      // the graceful floor is a no-op, not an error.
    },
    async openLink(url: string): Promise<void> {
      if (typeof window !== "undefined") window.open(url, "_blank")
    },
    onTeardown(cb: () => void): void {
      if (typeof window !== "undefined") window.addEventListener("beforeunload", cb)
    },
    onModeChange(cb: (mode: McpConnectionMode) => void): void {
      modeChangeListeners.push(cb)
    },
  }
}

/**
 * Resolve a `window.McpApp` bridge connection. Resolution order:
 * `window.McpApp` (host panel / `app serve` injection) → optimistic bridge
 * mode probed lazily on the first `callTool` (the `app dev` proxy) →
 * standalone. Never throws for a missing host — standalone is the graceful
 * floor. Can still reject if a *present* `window.McpApp.connect()` itself
 * rejects.
 */
export async function connectMcpApp(options: ConnectOptions = {}): Promise<McpConnection> {
  const bridgeRoute = options.bridgeRoute ?? DEFAULT_BRIDGE_ROUTE
  const standaloneTools = options.standaloneTools ?? {}

  const host = typeof window !== "undefined" ? window.McpApp : undefined
  if (host) {
    const bridge = await host.connect()
    return createHostConnection(bridge)
  }
  return createFallbackConnection(bridgeRoute, standaloneTools)
}
