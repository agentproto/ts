/**
 * Testable JSON-RPC host for an installed app's UI webview panel.
 *
 * The daemon serves each installed app's `ui.path` HTML at
 * `ui://app_ui_<slug>/view` with the `window.McpApp` bridge already injected
 * (packages/runtime app-ui-apps.ts) — the SAME surface an MCP-Apps host
 * renders. The extension reuses that html byte-for-byte inside a VS Code
 * webview (see appPanel.ts), and THIS controller is the host half: it answers
 * the bridge's `ui/initialize` handshake and maps its `tools/call` requests
 * onto the {@link AppDaemon} (the DaemonClient in production).
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

/** The daemon surface an app panel needs. Satisfied by `DaemonClient`. */
export interface AppDaemon {
  /** `app_tool_call` — dispatch a UI-allowlisted tool for an installed app. */
  appToolCall(appId: string, tool: string, args?: Record<string, unknown>): Promise<unknown>
}

interface RpcMessage {
  jsonrpc: "2.0"
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

export interface AppPanelControllerOptions {
  appId: string
  daemon: AppDaemon
  /** Send a message to the webview (relayed on into the panel iframe). */
  post: (msg: unknown) => void
}

/** JSON-RPC "method not found" — mapped to error code -32601. */
class MethodNotFoundError extends Error {}

export class AppPanelController {
  private readonly appId: string
  private readonly daemon: AppDaemon
  private readonly post: (msg: unknown) => void

  constructor(opts: AppPanelControllerOptions) {
    this.appId = opts.appId
    this.daemon = opts.daemon
    this.post = opts.post
  }

  /**
   * Handle one inbound bridge message. A request (has `id`) is answered with a
   * JSON-RPC result/error; a notification (`ui/notifications/initialized`, no
   * `id`) is acknowledged silently. Non-RPC traffic is ignored.
   */
  async handleMessage(raw: unknown): Promise<void> {
    if (!isRpcMessage(raw)) return
    // A notification carries no id and expects no response.
    if (raw.id === undefined || raw.id === null) return
    const id = raw.id
    try {
      const result = await this.dispatch(raw.method, raw.params ?? {})
      this.post({ jsonrpc: "2.0", id, result })
    } catch (err) {
      const code = err instanceof MethodNotFoundError ? -32601 : -32000
      const message = err instanceof Error ? err.message : String(err)
      this.post({ jsonrpc: "2.0", id, error: { code, message } })
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "ui/initialize":
        // A VS Code webview panel has no fullscreen/pip display modes, so
        // advertise inline only.
        return {
          hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] },
        }
      // Only inline is advertised; answer with the one mode we have rather
      // than erroring if a panel requests a switch anyway.
      case "ui/request-display-mode":
        return { mode: "inline" }
      // Accept-and-drop: there is no model conversation behind a standalone
      // panel to forward these to. A non-error result keeps the bridge happy.
      case "ui/message":
      case "ui/update-model-context":
        return {}
      case "tools/call":
        return this.callTool(
          typeof params.name === "string" ? params.name : "",
          isRecord(params.arguments) ? params.arguments : {},
        )
      default:
        throw new MethodNotFoundError(`unsupported method: ${method}`)
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "app_tool_call") {
      // The panels' own routing: callTool("app_tool_call", { appId, tool,
      // args }). Unpack it so the daemon call carries the real tool name;
      // the panel's appId is pinned — a panel only reaches its own app.
      const tool = typeof args.tool === "string" ? args.tool : ""
      if (!tool) throw new Error("app_tool_call: tool required")
      const toolArgs = isRecord(args.args) ? args.args : {}
      return jsonContent(await this.daemon.appToolCall(this.appId, tool, toolArgs))
    }
    return jsonContent(await this.daemon.appToolCall(this.appId, name, args))
  }
}

/** Wrap a JSON-serialisable value in the MCP text-content envelope the panels'
 *  `unwrapText` peels (`content[0].text`, JSON-parsed). */
function jsonContent(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRpcMessage(value: unknown): value is RpcMessage {
  return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string"
}
