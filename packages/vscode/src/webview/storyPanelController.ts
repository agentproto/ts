/**
 * Testable JSON-RPC host for the session-story webview panel.
 *
 * The story panel (packages/runtime `session-story-panel.ts`,
 * `SESSION_STORY_PANEL_HTML`) is a fully self-contained MCP-Apps surface: it
 * drives itself over a JSON-RPC 2.0 postMessage bridge, calling
 * `session_list` / `agent_export` / `agent_prompt` and re-fetching the export
 * on turn boundaries. It was authored to run inside an MCP-Apps host iframe;
 * the extension reuses the SAME html byte-for-byte inside a VS Code webview
 * (see storyPanel.ts), and THIS controller is the host half — it answers the
 * bridge's `ui/initialize` handshake and maps its three `tools/call` verbs
 * onto the {@link StoryDaemon} (the DaemonClient in production).
 *
 * Deliberately UI-free — a `StoryDaemon` seam plus a `post` callback — so the
 * bridge mapping has direct unit coverage without a real webview host. The
 * load-bearing part is the tool→daemon mapping, and it must emit exactly the
 * content envelope the panel's `callTool` unwraps: `result.content[0].text` is
 * a JSON string the panel `JSON.parse`s (see panel-bridge.ts's `callTool`).
 */

/** The daemon surface the story bridge needs. Satisfied by `DaemonClient`. */
export interface StoryDaemon {
  /** `session_list` → the picker + live status poll. */
  listSessions(opts?: { includeArchived?: boolean }): Promise<readonly StorySession[]>
  /**
   * `agent_export` with `format: "json"` → the timeline source. Returns the
   * daemon's `{ content }` envelope where `content` is a JSON string of the
   * ExportedSession (`{ meta, messages }`) — see transcript-export.ts's
   * `renderJson`. Passed through untouched: the panel parses it and reads
   * `.messages`.
   */
  exportSession(id: string, format: "json"): Promise<{ content: string }>
  /** `agent_prompt` → the composer. Fire-and-forget (`wait: false`). */
  prompt(id: string, prompt: string, opts: { wait: boolean }): Promise<unknown>
}

/** The session fields the panel reads (`titleOf`, status/kind filters, the
 *  turn-boundary `lastOutputAt`). Kept structural so a `SessionDescriptor`
 *  is assignable. */
export interface StorySession {
  id: string
  kind?: string
  status?: string
  label?: string
  name?: string
  command?: string
  lastOutputAt?: string
}

interface RpcMessage {
  jsonrpc: "2.0"
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

export interface StoryPanelControllerOptions {
  /** When set, the panel is nudged to auto-open this session on boot (via the
   *  host `tool-input` notification the panel already listens for) instead of
   *  landing on the picker. Omit to open the picker. */
  sessionId?: string
  daemon: StoryDaemon
  /** Send a message to the webview (relayed on into the panel iframe). */
  post: (msg: unknown) => void
}

export class StoryPanelController {
  private readonly sessionId: string | undefined
  private readonly daemon: StoryDaemon
  private readonly post: (msg: unknown) => void

  constructor(opts: StoryPanelControllerOptions) {
    this.sessionId = opts.sessionId
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
      const message = err instanceof Error ? err.message : String(err)
      this.post({ jsonrpc: "2.0", id, error: { code: -32000, message } })
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "ui/initialize": {
        // A VS Code webview panel has no fullscreen/pip display modes, so
        // advertise inline only — the bridge's floating toggle buttons then
        // never mount (see panel-bridge.ts's syncBtn).
        const result = {
          hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] },
        }
        // Best-effort auto-open: the panel picks up a sessionId from a host
        // tool-input/tool-call notification (session-story-panel.ts's
        // onHostNotification). Push it alongside the handshake so boot opens
        // the requested session rather than the picker. Ordered before the
        // result is posted, so pendingSessionId is set by the time initBridge
        // resolves.
        if (this.sessionId) {
          this.post({
            jsonrpc: "2.0",
            method: "tool-input",
            params: { arguments: { sessionId: this.sessionId } },
          })
        }
        return result
      }
      // Only inline is advertised, so this never fires in practice; answer it
      // harmlessly rather than erroring if a host requests it anyway.
      case "ui/request-display-mode":
        return {}
      case "tools/call":
        return this.callTool(
          typeof params.name === "string" ? params.name : "",
          isRecord(params.arguments) ? params.arguments : {},
        )
      default:
        throw new Error(`unsupported method: ${method}`)
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "session_list": {
        const sessions = await this.daemon.listSessions()
        return jsonContent({ sessions })
      }
      case "agent_export": {
        const id = args.sessionId
        if (typeof id !== "string" || !id) throw new Error("agent_export: sessionId required")
        const exported = await this.daemon.exportSession(id, "json")
        // exported.content is ALREADY a JSON string of the ExportedSession
        // ({ meta, messages }); the panel JSON.parses content[0].text and
        // reads .messages, so pass it straight through — parsing and
        // re-stringifying here would only round-trip it.
        return { content: [{ type: "text", text: exported.content }] }
      }
      case "agent_prompt": {
        const id = args.sessionId
        const prompt = args.prompt
        if (typeof id !== "string" || !id) throw new Error("agent_prompt: sessionId required")
        if (typeof prompt !== "string") throw new Error("agent_prompt: prompt required")
        await this.daemon.prompt(id, prompt, { wait: false })
        // The panel ignores the payload (fire-and-forget) — any non-error
        // envelope satisfies its callTool unwrap.
        return jsonContent({ ok: true })
      }
      default:
        throw new Error(`unsupported tool: ${name}`)
    }
  }
}

/** Wrap a JSON-serialisable value in the MCP text-content envelope the panel's
 *  `callTool` unwraps (`result.content[0].text`). */
function jsonContent(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRpcMessage(value: unknown): value is RpcMessage {
  return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string"
}
