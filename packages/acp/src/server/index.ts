/**
 * AIP-44 ACP server — exposes an AIP-9 operator to ACP-speaking clients.
 *
 * Thin wrapper around `@agentclientprotocol/sdk`'s `AgentSideConnection`.
 * Hosts the connection, maps incoming `session/prompt` requests onto an
 * `onPrompt` handler, and bridges `session/update` notifications to the
 * caller's audit emitter via the per-session context.
 */

import {
  AgentSideConnection,
  ndJsonStream,
  type Agent as AcpAgentHandlers,
  type Stream,
} from "@agentclientprotocol/sdk"
import type { AcpHandle } from "../types.js"

export interface AcpServerOptions {
  /** AIP-44 manifest describing the server's role + capabilities. */
  handle: AcpHandle
  /** Output bytes go here (client stdin / WS write side). */
  output: WritableStream<Uint8Array>
  /** Input bytes come from here (client stdout / WS read side). */
  input: ReadableStream<Uint8Array>
  /** Hook invoked when a client calls `session/prompt`. */
  onPrompt?: (params: unknown, ctx: AcpServerSessionContext) => Promise<unknown>
  /** Hook invoked on `session/cancel`. */
  onCancel?: (sessionId: string) => Promise<void>
}

export interface AcpServerSessionContext {
  readonly sessionId: string
  /** Push a `session/update` notification to the connected client. */
  sendUpdate(update: unknown): Promise<void>
  /** Aborts when the client sends `session/cancel`. */
  readonly signal: AbortSignal
}

export interface AcpServer {
  readonly connection: AgentSideConnection
  close(): Promise<void>
}

export function createAcpServer(options: AcpServerOptions): AcpServer {
  const stream: Stream = ndJsonStream(options.output, options.input)

  const connection = new AgentSideConnection(
    (conn) => buildAgentHandlers(conn, options),
    stream,
  )

  return {
    connection,
    async close() {},
  }
}

function buildAgentHandlers(
  conn: AgentSideConnection,
  options: AcpServerOptions,
): AcpAgentHandlers {
  void options.handle

  return {
    async initialize(params) {
      void params
      throw new Error("AcpServer.initialize: not yet implemented")
    },
    async authenticate(params) {
      void params
      throw new Error("AcpServer.authenticate: not yet implemented")
    },
    async newSession(params) {
      void params
      throw new Error("AcpServer.newSession: not yet implemented")
    },
    async loadSession(params) {
      void params
      throw new Error("AcpServer.loadSession: not yet implemented")
    },
    async cancel(params) {
      if (options.onCancel) {
        await options.onCancel(params.sessionId)
        return
      }
    },
    async prompt(params) {
      if (!options.onPrompt) {
        throw new Error("AcpServer.prompt: no onPrompt handler configured")
      }
      const sessionId = (params as { sessionId?: string }).sessionId ?? "unknown"
      const controller = new AbortController()
      const ctx: AcpServerSessionContext = {
        sessionId,
        signal: controller.signal,
        sendUpdate: async (update) => {
          await conn.sessionUpdate(update as never)
        },
      }
      try {
        return (await options.onPrompt(params, ctx)) as never
      } catch (err) {
        controller.abort()
        throw err
      }
    },
  } as AcpAgentHandlers
}
