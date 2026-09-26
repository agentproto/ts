/**
 * Transport-agnostic MCP Apps host core (spec `2026-01-26`).
 *
 * A thin wrapper over the official `AppBridge` from
 * `@modelcontextprotocol/ext-apps/app-bridge` — the bridge owns the protocol
 * (the `ui/initialize` handshake, schema validation, JSON-RPC plumbing); this
 * module only maps an embedder's {@link McpAppHostHandlers} onto it and adds
 * the two behaviours every embedder needs and the bridge leaves to the host:
 *
 * - **Pre-ready queueing.** `sendToolInput` / `sendToolResult` /
 *   `sendToolCancelled` called before the view sent
 *   `ui/notifications/initialized` are held and flushed, in call order, once
 *   it has. A view that registers `ontoolinput` in `connect()` would
 *   otherwise miss a notification that raced its handshake.
 * - **Honest capabilities.** Only what a handler exists for is advertised in
 *   `hostCapabilities` (`openLinks` iff `openLink`, `logging` iff `onLog`,
 *   `message` iff `sendMessage`, …), so a view can branch on them.
 *
 * Missing-handler behaviour: `ui/message` and `ui/update-model-context`
 * accept and drop (reply `{}`), matching the VS Code panel host
 * (packages/vscode appPanelController.ts). `ui/open-link` without a handler
 * is left unregistered, so the bridge answers JSON-RPC "Method not found".
 * `ui/request-display-mode` without a handler keeps AppBridge's own default
 * (reply with the current `hostContext.displayMode`), which is what the spec
 * asks of a host that declines a switch.
 */

import {
  AppBridge,
  type McpUiDisplayMode,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiMessageRequest,
  type McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type {
  CallToolResult,
  LoggingMessageNotification,
} from "@modelcontextprotocol/sdk/types.js"

export type { Transport }
export type { CallToolResult, LoggingMessageNotification }
export type {
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiMessageRequest,
  McpUiUpdateModelContextRequest,
}

export interface McpAppHostHandlers {
  callTool(params: {
    name: string
    arguments?: Record<string, unknown>
  }): Promise<CallToolResult>
  /** ui/message. Resolve {} when accepted; reject → error to the view. */
  sendMessage?(params: McpUiMessageRequest["params"]): Promise<void>
  updateModelContext?(params: McpUiUpdateModelContextRequest["params"]): Promise<void>
  openLink?(url: string): Promise<void>
  requestDisplayMode?(
    mode: "inline" | "fullscreen" | "pip",
  ): Promise<"inline" | "fullscreen" | "pip">
  onSizeChanged?(size: { width?: number; height?: number }): void
  onLog?(params: LoggingMessageNotification["params"]): void
  onTeardownRequested?(): void
}

export interface McpAppHostOptions {
  hostInfo: { name: string; version: string }
  hostContext: McpUiHostContext
  handlers: McpAppHostHandlers
}

export interface McpAppHost {
  sendToolInput(args: Record<string, unknown>): Promise<void>
  sendToolResult(result: CallToolResult): Promise<void>
  sendToolCancelled(reason?: string): Promise<void>
  setHostContext(partial: Partial<McpUiHostContext>): Promise<void>
  /** Resolves once the view sent ui/notifications/initialized. */
  ready: Promise<void>
  teardown(): Promise<void>
}

/** How long {@link McpAppHost.teardown} waits for the view to answer
 *  `ui/resource-teardown` before closing the transport anyway. */
const TEARDOWN_TIMEOUT_MS = 2_000

/** The content modalities a host that forwards `ui/message` /
 *  `ui/update-model-context` can carry. Text + structured content is what
 *  every consumer (a chat prompt, a VS Code panel) actually handles. */
const FORWARDED_MODALITIES = { text: {}, structuredContent: {} } as const

export function buildHostCapabilities(handlers: McpAppHostHandlers): McpUiHostCapabilities {
  const caps: McpUiHostCapabilities = { serverTools: {} }
  if (handlers.openLink) caps.openLinks = {}
  if (handlers.onLog) caps.logging = {}
  if (handlers.sendMessage) caps.message = { ...FORWARDED_MODALITIES }
  if (handlers.updateModelContext) caps.updateModelContext = { ...FORWARDED_MODALITIES }
  return caps
}

export async function createMcpAppHost(
  transport: Transport,
  opts: McpAppHostOptions,
): Promise<McpAppHost> {
  const { handlers } = opts
  let hostContext: McpUiHostContext = { ...opts.hostContext }

  const bridge = new AppBridge(null, opts.hostInfo, buildHostCapabilities(handlers), {
    hostContext,
  })

  let initialized = false
  let closed = false
  let resolveReady!: () => void
  let rejectReady!: (err: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A host torn down before the view initialized rejects `ready`; a caller
  // that never awaited it must not see an unhandled rejection for that.
  ready.catch(() => {})

  bridge.oninitialized = () => {
    initialized = true
    resolveReady()
  }

  bridge.oncalltool = (params) =>
    handlers.callTool(
      params.arguments === undefined
        ? { name: params.name }
        : { name: params.name, arguments: params.arguments },
    )

  const sendMessage = handlers.sendMessage
  bridge.onmessage = async (params) => {
    if (sendMessage) await sendMessage(params)
    return {}
  }
  const updateModelContext = handlers.updateModelContext
  bridge.onupdatemodelcontext = async (params) => {
    if (updateModelContext) await updateModelContext(params)
    return {}
  }

  const openLink = handlers.openLink
  if (openLink) {
    bridge.onopenlink = async ({ url }) => {
      await openLink(url)
      return {}
    }
  }

  const requestDisplayMode = handlers.requestDisplayMode
  if (requestDisplayMode) {
    bridge.onrequestdisplaymode = async ({ mode }) => {
      const granted = await requestDisplayMode(mode)
      if (granted !== hostContext.displayMode) applyHostContext({ displayMode: granted })
      return { mode: granted }
    }
  }

  const onSizeChanged = handlers.onSizeChanged
  if (onSizeChanged) bridge.onsizechange = (size) => onSizeChanged(size)
  const onLog = handlers.onLog
  if (onLog) bridge.onloggingmessage = (params) => onLog(params)
  const onTeardownRequested = handlers.onTeardownRequested
  if (onTeardownRequested) bridge.onrequestteardown = () => onTeardownRequested()

  function applyHostContext(partial: Partial<McpUiHostContext>): void {
    hostContext = { ...hostContext, ...partial }
    // AppBridge.setHostContext replaces its whole context and notifies the
    // view with just the keys that changed.
    bridge.setHostContext(hostContext)
  }

  // Every outbound notification is serialized through one chain gated on
  // `ready`, so pre-ready sends flush in call order and post-ready sends
  // can't overtake them.
  let outbound: Promise<void> = ready
  function enqueue(send: () => Promise<void>): Promise<void> {
    if (closed) return Promise.reject(new Error("MCP App host is torn down"))
    const next = outbound.then(send)
    outbound = next.catch(() => {})
    return next
  }

  // A transport that goes away before the handshake fails `ready` (and
  // everything queued behind it) instead of leaving it pending forever.
  bridge.onclose = () => {
    closed = true
    if (!initialized) rejectReady(new Error("MCP App transport closed before the view initialized"))
  }

  await bridge.connect(transport)

  return {
    ready,
    sendToolInput: (args) => enqueue(() => bridge.sendToolInput({ arguments: args })),
    sendToolResult: (result) => enqueue(() => bridge.sendToolResult(result)),
    sendToolCancelled: (reason) =>
      enqueue(() => bridge.sendToolCancelled(reason === undefined ? {} : { reason })),
    async setHostContext(partial) {
      if (closed) throw new Error("MCP App host is torn down")
      applyHostContext(partial)
    },
    async teardown() {
      if (closed) return
      if (initialized) {
        // Spec: the host asks the view to clean up and waits for its answer
        // before unmounting. A view that never answers mustn't wedge us.
        await bridge
          .teardownResource({}, { timeout: TEARDOWN_TIMEOUT_MS })
          .catch(() => {})
      }
      closed = true
      rejectReady(new Error("MCP App host torn down before the view initialized"))
      await bridge.close()
    },
  }
}
