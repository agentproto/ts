/**
 * AIP-44 ACP client — drives a subprocess agent via stdio JSON-RPC.
 *
 * Wraps `@agentclientprotocol/sdk`'s `ClientSideConnection`. Owns the
 * connection lifecycle, runs `initialize` on construction, and exposes
 * a session API where each `prompt()` call returns an
 * `AsyncIterable<StreamEvent>` fed by the SDK's `session/update`
 * notification handler.
 */

import {
  ClientSideConnection,
  ndJsonStream,
  type Client as AcpClientHandlers,
  type Stream,
} from "@agentclientprotocol/sdk"
import type { StreamEvent } from "../types.js"

const PROTOCOL_VERSION_DEFAULT = 1

export interface AcpClientOptions {
  /** Output bytes go here (subprocess stdin). */
  output: WritableStream<Uint8Array>
  /** Input bytes come from here (subprocess stdout). */
  input: ReadableStream<Uint8Array>
  /** Client identity advertised during `initialize`. */
  clientInfo?: {
    name: string
    title?: string
    version?: string
  }
  /** Client capabilities advertised during `initialize`. */
  capabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean }
    terminal?: boolean
  }
  /** Optional handlers for agent-initiated requests beyond fs / terminal. */
  handlers?: Partial<AcpClientHandlers>
  /** Protocol version to negotiate. Defaults to the SDK's current. */
  protocolVersion?: number
}

export interface AcpClient {
  readonly connection: ClientSideConnection
  /** Negotiated agent capabilities returned from `initialize`. */
  readonly agentCapabilities: Record<string, unknown> | undefined
  newSession(params: {
    cwd: string
    mcpServers?: unknown[]
  }): Promise<AcpClientSession>
  close(): Promise<void>
}

export interface AcpClientSession {
  readonly sessionId: string
  prompt(input: {
    messages: unknown[]
    signal?: AbortSignal
  }): AsyncIterable<StreamEvent>
  cancel(): Promise<void>
  close(): Promise<void>
}

interface SessionState {
  events: StreamEvent[]
  resolveNext: ((evt: StreamEvent | undefined) => void) | null
  done: boolean
  active: boolean
}

export async function createAcpClient(
  options: AcpClientOptions,
): Promise<AcpClient> {
  const sessions = new Map<string, SessionState>()

  const stream: Stream = ndJsonStream(options.output, options.input)

  const connection: ClientSideConnection = new ClientSideConnection(
    () => buildClientHandlers(options.handlers ?? {}, sessions),
    stream,
  )

  const initResponse = await connection.initialize({
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION_DEFAULT,
    clientCapabilities: clientCapabilitiesFromOptions(options),
    clientInfo: options.clientInfo
      ? {
          name: options.clientInfo.name,
          title: options.clientInfo.title ?? options.clientInfo.name,
          version: options.clientInfo.version ?? "0.0.0",
        }
      : undefined,
  } as never)

  return {
    connection,
    agentCapabilities: (initResponse as { agentCapabilities?: Record<string, unknown> })
      .agentCapabilities,
    async newSession(params) {
      const response = await connection.newSession({
        cwd: params.cwd,
        mcpServers: (params.mcpServers ?? []) as never,
      } as never)
      const sessionId = (response as { sessionId: string }).sessionId
      const state: SessionState = {
        events: [],
        resolveNext: null,
        done: false,
        active: false,
      }
      sessions.set(sessionId, state)
      return buildSession(connection, sessionId, state, sessions)
    },
    async close() {
      sessions.clear()
    },
  }
}

function clientCapabilitiesFromOptions(
  options: AcpClientOptions,
): Record<string, unknown> {
  const caps = options.capabilities ?? {}
  return {
    fs: {
      readTextFile: caps.fs?.readTextFile ?? false,
      writeTextFile: caps.fs?.writeTextFile ?? false,
    },
    terminal: caps.terminal ?? false,
  }
}

function buildSession(
  connection: ClientSideConnection,
  sessionId: string,
  state: SessionState,
  sessions: Map<string, SessionState>,
): AcpClientSession {
  return {
    sessionId,
    prompt(input) {
      if (state.active) {
        throw new Error(
          `AcpClientSession.prompt: session ${sessionId} already has an in-flight prompt`,
        )
      }
      state.active = true
      state.done = false
      state.events.length = 0

      const iter = makeIterator(state)

      const promise = connection
        .prompt({
          sessionId,
          prompt: input.messages as never,
        } as never)
        .then((response) => {
          enqueue(state, {
            kind: "turn-end",
            sessionId,
            reason:
              ((response as { stopReason?: string }).stopReason ===
                "cancelled" && "cancelled") ||
              ((response as { stopReason?: string }).stopReason ===
                "max_turns" && "max_turns") ||
              "completed",
          })
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : String(err)
          enqueue(state, {
            kind: "error",
            sessionId,
            error: { message },
          })
        })
        .finally(() => {
          state.active = false
          state.done = true
          flush(state)
        })

      if (input.signal) {
        input.signal.addEventListener(
          "abort",
          () => {
            void connection.cancel({ sessionId } as never)
          },
          { once: true },
        )
      }

      void promise
      return iter
    },
    async cancel() {
      if (!state.active) return
      await connection.cancel({ sessionId } as never)
    },
    async close() {
      sessions.delete(sessionId)
    },
  }
}

function makeIterator(state: SessionState): AsyncIterable<StreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (state.events.length > 0) {
            const value = state.events.shift() as StreamEvent
            return { value, done: false }
          }
          if (state.done) return { value: undefined, done: true }
          const value = await new Promise<StreamEvent | undefined>(
            (resolve) => {
              state.resolveNext = resolve
            },
          )
          if (value === undefined) return { value: undefined, done: true }
          return { value, done: false }
        },
      }
    },
  }
}

function enqueue(state: SessionState, event: StreamEvent) {
  if (state.resolveNext) {
    const r = state.resolveNext
    state.resolveNext = null
    r(event)
    return
  }
  state.events.push(event)
}

function flush(state: SessionState) {
  if (state.resolveNext) {
    const r = state.resolveNext
    state.resolveNext = null
    r(undefined)
  }
}

function buildClientHandlers(
  partial: Partial<AcpClientHandlers>,
  sessions: Map<string, SessionState>,
): AcpClientHandlers {
  return {
    async sessionUpdate(params) {
      const sid = (params as { sessionId?: string }).sessionId
      if (!sid) return
      const state = sessions.get(sid)
      if (!state) return

      const update = (params as { update?: Record<string, unknown> }).update
      if (!update) return
      const event = translateSessionUpdate(sid, update)
      if (event) enqueue(state, event)

      if (partial.sessionUpdate) await partial.sessionUpdate(params)
    },
    async requestPermission(params) {
      if (partial.requestPermission) return partial.requestPermission(params)
      throw new Error("AcpClient.requestPermission: no handler configured")
    },
    async readTextFile(params) {
      if (partial.readTextFile) return partial.readTextFile(params)
      throw new Error("AcpClient.readTextFile: capability not advertised")
    },
    async writeTextFile(params) {
      if (partial.writeTextFile) return partial.writeTextFile(params)
      throw new Error("AcpClient.writeTextFile: capability not advertised")
    },
    ...(partial as object),
  } as AcpClientHandlers
}

function translateSessionUpdate(
  sessionId: string,
  update: Record<string, unknown>,
): StreamEvent | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return {
        kind: "text-delta",
        sessionId,
        text: extractText(update.content),
      }
    case "agent_thought_chunk":
      return {
        kind: "thought",
        sessionId,
        text: extractText(update.content),
      }
    case "tool_call": {
      const toolCallId = (update.toolCallId as string) ?? ""
      return {
        kind: "tool-call",
        sessionId,
        toolCallId,
        toolName: (update.kind as string) ?? (update.title as string) ?? "tool",
        arguments: update.rawInput ?? update.content ?? {},
      }
    }
    case "tool_call_update": {
      const status = update.status as string | undefined
      if (status === "completed" || status === "failed") {
        return {
          kind: "tool-result",
          sessionId,
          toolCallId: (update.toolCallId as string) ?? "",
          result: update.rawOutput ?? update.content ?? null,
          isError: status === "failed",
        }
      }
      return null
    }
    case "user_message_chunk":
      return null
    default:
      return null
  }
}

function extractText(content: unknown): string {
  if (!content) return ""
  if (typeof content === "string") return content
  if (typeof content === "object" && content !== null) {
    const c = content as { type?: string; text?: string }
    if (c.type === "text" && typeof c.text === "string") return c.text
  }
  return ""
}
