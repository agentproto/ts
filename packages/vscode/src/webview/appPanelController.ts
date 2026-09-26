/**
 * Testable MCP Apps host for an installed app's UI webview panel.
 *
 * The daemon serves each installed app's `ui.path` HTML at
 * `ui://app_ui_<slug>/view` with the `window.McpApp` bridge already injected
 * (packages/runtime app-ui-apps.ts) — the SAME surface an MCP-Apps host
 * renders. The extension reuses that html byte-for-byte inside a VS Code
 * webview (see appPanel.ts), and THIS controller is the host half: it sits on
 * `@agentproto/mcp-app-host`'s `createMcpAppHost` (the same host core
 * session-chat and the DOM adapter use, wrapping the official `AppBridge`
 * from `@modelcontextprotocol/ext-apps`) for `tools/call` /
 * `ui/request-display-mode` / `ui/message` / `ui/update-model-context`. The
 * one exception is `ui/initialize`, answered directly by
 * {@link WebviewRelayTransport.receive} — see the comment there for why.
 *
 * `WebviewRelayTransport` is the MCP SDK `Transport` this controller feeds
 * `createMcpAppHost`: outbound messages go through the panel's `post`
 * callback (relayed into the webview by appPanel.ts's `buildAppHostHtml`
 * relay script), and inbound webview messages arrive via {@link
 * AppPanelController.handleMessage} and are fed back in through {@link
 * WebviewRelayTransport.receive}.
 *
 * The bridge routes every app tool through the daemon's `app_tool_call`
 * itself (`callTool("app_tool_call", { appId, tool, args })` — see e.g.
 * packages/apps mail-triage/ui.ts's `callApp`), so that name is dispatched by
 * unpacking its arguments; any other name is treated as a direct app tool
 * call under this panel's appId. Either way the daemon enforces the app's
 * `ui.tools` allowlist. Results are re-wrapped in the MCP text-content
 * envelope the panels' `unwrapText` peels (`content[0].text`, JSON-parsed).
 *
 * Deliberately UI-free — an `AppDaemon` seam plus a `post` callback — so the
 * bridge mapping has direct unit coverage without a real webview host.
 */

import {
  createMcpAppHost,
  type CallToolResult,
  type McpAppHost,
  type McpAppHostHandlers,
  type Transport,
} from "@agentproto/mcp-app-host"
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js"

/** The daemon surface an app panel needs. Satisfied by `DaemonClient`. */
export interface AppDaemon {
  /** `app_tool_call` — dispatch a UI-allowlisted tool for an installed app. */
  appToolCall(appId: string, tool: string, args?: Record<string, unknown>): Promise<unknown>
  /** Direct tool dispatch. Only used in builtin mode (see
   *  {@link AppPanelControllerOptions.builtinTools}): a builtin panel has no
   *  installed-app record for `app_tool_call` to resolve against. */
  mcpCall(tool: string, args?: Record<string, unknown>): Promise<unknown>
}

export interface AppPanelControllerOptions {
  appId: string
  daemon: AppDaemon
  /** Send a message to the webview (relayed on into the panel iframe). */
  post: (msg: unknown) => void
  /**
   * Builtin mode: the panel's declared tool allowlist. Set it for a builtin
   * panel (`app_catalog` `category: "builtin"`), leave it undefined for an
   * installed app.
   *
   * A builtin's html calls daemon tools by their REAL names — the work board
   * calls `task_list` / `task_claim` / `task_update` / `task_create`
   * (packages/apps work-board/index.ts `ui.tools`) — because it is compiled
   * into the daemon rather than installed, so `app_tool_call` has no app
   * record to resolve its appId against and would reject every call. In
   * builtin mode the bridge therefore dispatches straight to the daemon, and
   * THIS list is what keeps that from being an open tool proxy for html the
   * panel fetched: a name outside it is refused here, client-side.
   */
  builtinTools?: readonly string[]
}

const HOST_INFO = { name: "agentproto-vscode", version: "1.0.0" }

/** A VS Code webview panel has no fullscreen/pip display modes. */
const HOST_CONTEXT = { displayMode: "inline" as const, availableDisplayModes: ["inline" as const] }

/**
 * The request methods `createMcpAppHost`/`AppBridge` answer for this host.
 * `ui/request-display-mode`/`ui/message`/`ui/update-model-context` fall back
 * to its documented no-handler defaults (see host.ts); `tools/call` goes to
 * our `callTool` handler. `ui/initialize` is NOT in this set — it's answered
 * directly by {@link WebviewRelayTransport.receive} instead of being
 * delegated to `AppBridge`, see the comment there. Anything else — including
 * `ui/open-link`, since we pass no `openLink` handler — is refused by
 * `receive` before it ever reaches the bridge, so the refusal reads
 * "unsupported method: X" instead of AppBridge's generic "Method not found",
 * matching this panel's pre-port behaviour.
 */
const KNOWN_REQUEST_METHODS = new Set<string>([
  "ui/request-display-mode",
  "ui/message",
  "ui/update-model-context",
  "tools/call",
])

/** A JSON-RPC error carrying an explicit code, so the SDK's request-handling
 *  wrapper reports it verbatim instead of falling back to -32603 Internal
 *  error for a plain `Error`. */
class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}

/**
 * MCP SDK `Transport` relaying over a VS Code webview's postMessage channel:
 * outbound messages go through `post` (out to the webview), inbound messages
 * arrive via {@link receive} (fed by {@link AppPanelController.handleMessage}).
 *
 * Filters two things before anything reaches the bridge:
 * - Non-JSON-RPC traffic (garbage, or messages from something other than the
 *   panel bridge script) is dropped silently.
 * - A request for a method this host doesn't answer (see
 *   {@link KNOWN_REQUEST_METHODS}) is refused directly, without waiting on
 *   `AppBridge`'s own generic fallback, so the error message matches this
 *   panel's pre-port wording.
 *
 * `receive` also resolves only once any reply the bridge produces for that
 * message has actually been posted (tracked in `pending`, keyed by request
 * id). The bridge's own request dispatch is fire-and-forget from a
 * `Transport`'s point of view (`onmessage` returns `void`; the eventual
 * `send()` happens down an internal promise chain) — but this panel's
 * `AppPanelController.handleMessage` is awaited by its caller in tests
 * asserting on the posted reply immediately after, so it must not resolve
 * before that reply crosses the wire.
 */
class WebviewRelayTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private readonly pending = new Map<string | number, () => void>()

  constructor(private readonly post: (msg: unknown) => void) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.post(message)
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id != null) {
      this.pending.get(message.id)?.()
    }
  }

  async close(): Promise<void> {
    this.onclose?.()
  }

  /** Feed one inbound webview message in, resolving once its reply (if any)
   *  has been posted back. */
  async receive(raw: unknown): Promise<void> {
    const parsed = JSONRPCMessageSchema.safeParse(raw)
    if (!parsed.success) return
    const message = parsed.data
    if (!isJSONRPCRequest(message)) {
      this.onmessage?.(message)
      return
    }
    if (message.method === "ui/initialize") {
      // Answered directly rather than delegated to AppBridge: a real
      // `ui/initialize` request (packages/apps panel-bridge.ts's
      // initBridge()) carries appInfo/appCapabilities/protocolVersion, which
      // AppBridge's own handshake schema requires and its result echoes back
      // alongside protocolVersion/hostCapabilities/hostInfo — more than this
      // panel has ever answered with. A VS Code webview panel has no
      // fullscreen/pip display modes, so hostContext is all a view needs.
      this.post({ jsonrpc: "2.0", id: message.id, result: { hostContext: HOST_CONTEXT } })
      return
    }
    if (!KNOWN_REQUEST_METHODS.has(message.method)) {
      this.post({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unsupported method: ${message.method}` },
      })
      return
    }
    const replied = new Promise<void>((resolve) => this.pending.set(message.id, resolve))
    this.onmessage?.(message)
    await replied
    this.pending.delete(message.id)
  }
}

export class AppPanelController {
  private readonly transport: WebviewRelayTransport
  private readonly hostPromise: Promise<McpAppHost>

  constructor(opts: AppPanelControllerOptions) {
    this.transport = new WebviewRelayTransport(opts.post)
    const handlers: McpAppHostHandlers = {
      callTool: (params) => callTool(opts, params.name, params.arguments ?? {}),
    }
    this.hostPromise = createMcpAppHost(this.transport, {
      hostInfo: HOST_INFO,
      hostContext: HOST_CONTEXT,
      handlers,
    })
    // A caller that never disposes the panel before the extension shuts down
    // must not see an unhandled rejection for a host that never finished
    // connecting.
    this.hostPromise.catch(() => {})
  }

  /**
   * Handle one inbound bridge message. Awaiting the host's construction first
   * guarantees the transport's `onmessage` is wired before the message is
   * fed in, regardless of `createMcpAppHost`'s internal connect timing.
   */
  async handleMessage(raw: unknown): Promise<void> {
    await this.hostPromise.catch(() => {})
    await this.transport.receive(raw)
  }
}

async function callTool(
  opts: Pick<AppPanelControllerOptions, "appId" | "daemon" | "builtinTools">,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const { appId, daemon, builtinTools } = opts
  try {
    if (builtinTools) {
      // Builtin panel: no app record, so route to the daemon tool itself,
      // gated by the panel's declared allowlist. A builtin never wraps its
      // calls in `app_tool_call`, so that name is not special-cased here —
      // it would simply fail the allowlist like any other unlisted tool.
      if (!name) throw new Error("tools/call: name required")
      if (!builtinTools.includes(name)) {
        throw new Error(`tool '${name}' is not allowed for builtin panel '${appId}'`)
      }
      return jsonContent(await daemon.mcpCall(name, args))
    }
    if (name === "app_tool_call") {
      // The panels' own routing: callTool("app_tool_call", { appId, tool,
      // args }). Unpack it so the daemon call carries the real tool name;
      // the panel's appId is pinned — a panel only reaches its own app.
      const tool = typeof args.tool === "string" ? args.tool : ""
      if (!tool) throw new Error("app_tool_call: tool required")
      const toolArgs = isRecord(args.args) ? args.args : {}
      return jsonContent(await daemon.appToolCall(appId, tool, toolArgs))
    }
    return jsonContent(await daemon.appToolCall(appId, name, args))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new RpcError(message, -32000)
  }
}

/** Wrap a JSON-serialisable value in the MCP text-content envelope the panels'
 *  `unwrapText` peels (`content[0].text`, JSON-parsed). */
function jsonContent(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
