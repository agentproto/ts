/**
 * @agentproto/harness — transport client (WP1).
 *
 * The single place that touches the MCP SDK + JSON-payload parsing. Connects to
 * the daemon's `/mcp` endpoint over `StreamableHTTPClientTransport` and exposes
 * typed wrappers over the session tools. Mirrors the proven pattern in
 * `packages/cli/src/commands/mcp-bridge.ts:30-58`.
 *
 * Tool results come back as `content: [{ type: "text", text: <JSON> }]`; the
 * `#call` helper unwraps + parses that text payload.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type {
  ConnectHarnessOptions,
  SessionDescriptor,
  StartAgentArgs,
  TurnEvent,
  TurnResult,
} from "./types.js"

/** Default daemon MCP endpoint (port 18790; `serve.ts:186,865`). */
export const DEFAULT_MCP_URL = "http://127.0.0.1:18790/mcp"

/**
 * Resolve the daemon URL: explicit option → `AGENTPROTO_MCP_URL` → default.
 */
export function resolveMcpUrl(opts?: ConnectHarnessOptions): string {
  return (
    opts?.url ?? process.env.AGENTPROTO_MCP_URL ?? DEFAULT_MCP_URL
  )
}

/**
 * Thin typed facade over the daemon's session MCP tools. One instance is shared
 * by all harnesses created against the same daemon.
 */
export class HarnessClient {
  readonly url: string
  #client: Client

  private constructor(url: string, client: Client) {
    this.url = url
    this.#client = client
  }

  /**
   * Connect an MCP client over HTTP to the daemon's `/mcp` endpoint.
   */
  static async connect(opts?: ConnectHarnessOptions): Promise<HarnessClient> {
    const url = resolveMcpUrl(opts)
    const client = new Client(
      { name: "harness", version: "0.1.0" },
      { capabilities: {} },
    )
    const transport = new StreamableHTTPClientTransport(new URL(url))
    await client.connect(transport)
    return new HarnessClient(url, client)
  }

  /** Spawn a session via `agent_start`.
   *
   *  Uses a 180s request timeout instead of the MCP SDK's 60s default: a
   *  spawn on a COLD daemon (freshly booted sandbox box, first import of a
   *  just-installed adapter package) legitimately exceeds 60s — observed
   *  live against an e2b box, where the default timeout aborted an
   *  otherwise-successful spawn (`MCP error -32001`). Failures still
   *  surface immediately; the ceiling only bounds the wait. */
  async start(args: StartAgentArgs): Promise<SessionDescriptor> {
    return this.#call("agent_start", args as unknown as Record<string, unknown>, {
      timeoutMs: 180_000,
    })
  }

  /** Send a follow-up turn via `agent_prompt` (fire-and-forget). `opts.interrupt`
   *  cancels an in-flight turn and redirects the session onto this prompt instead
   *  of rejecting (see `agent_prompt`'s `interrupt` field). */
  async prompt(sessionId: string, prompt: string, opts?: { interrupt?: boolean }): Promise<void> {
    await this.#call("agent_prompt", {
      sessionId,
      prompt,
      ...(opts?.interrupt !== undefined ? { interrupt: opts.interrupt } : {}),
    })
  }

  /** Tail the ring buffer via `agent_output`. */
  async output(sessionId: string, lastN?: number): Promise<string> {
    const res = await this.#call<{ lines?: string[] }>(
      "agent_output",
      { sessionId, lastN },
    )
    return (res.lines ?? []).join("\n")
  }

  /** SIGTERM via `agent_kill`. */
  async kill(sessionId: string): Promise<void> {
    await this.#call("agent_kill", { sessionId })
  }

  /**
   * Multiplexed long-poll via `session_monitor`. `timeoutMs` is clamped to the
   * tool's 1 000–49 000 window; a clean timeout surfaces as
   * `{ timedOut: true, sessionIds }` with no `event` field at all — `event`
   * is only ever set (to `"turn-end"|"awaiting-input"|"exited"`) on a real
   * match. Callers must check `timedOut`, not `event`, to detect a timeout.
   *
   * MCP request timeout = the long-poll window + a 60s grace, NOT the SDK's
   * flat 60s default: the server holds the request open for up to the window
   * (49s), which left only ~11s of real headroom — a remote daemon whose
   * event loop stalls under load (observed: an e2b microVM saturated by a
   * monorepo clone + a model turn) blew past it and the client threw
   * `MCP error -32001`, killing an otherwise healthy multi-minute turn.
   */
  async waitForAny(
    sessionIds: string[],
    opts?: { timeoutMs?: number; event?: TurnEvent },
  ): Promise<TurnResult> {
    const windowMs = Math.min(Math.max(opts?.timeoutMs ?? 49_000, 1_000), 49_000)
    return this.#call(
      "session_monitor",
      {
        sessionIds,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.event !== undefined ? { event: opts.event } : {}),
      },
      { timeoutMs: windowMs + 60_000 },
    )
  }

  /**
   * Snapshot the session hierarchy via `session_tree`. When called from a
   * scoped orchestrator token only the caller's subtree is returned.
   */
  async sessionTree(sessionId: string, onlyAlive?: boolean): Promise<unknown> {
    return this.#call("session_tree", {
      sessionId,
      ...(onlyAlive !== undefined ? { onlyAlive } : {}),
    })
  }

  /** Disconnect the underlying transport. */
  async close(): Promise<void> {
    await this.#client.close()
  }

  // ── private helpers ────────────────────────────────────────────────

  /** Call a daemon MCP tool and unwrap its JSON response. `timeoutMs`
   *  overrides the MCP SDK's 60s default request timeout for calls that can
   *  legitimately run long (see `start`). */
  async #call<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const res = await this.#client.callTool(
      { name, arguments: args },
      undefined,
      opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined,
    )
    const text = (
      res.content as Array<{ type: string; text?: string }>
    )[0]?.text
    if (!text) {
      throw new Error(`No content from tool \`${name}\``)
    }
    // TODO: remove cast once SDK types are stable — CallToolResult already
    // carries isError?: boolean in newer SDK versions.
    if ((res as { isError?: boolean }).isError) {
      throw new Error(`Tool \`${name}\` returned error: ${text}`)
    }
    return JSON.parse(text) as T
  }
}
