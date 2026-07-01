/**
 * AIP-45 protocol arm: `protocol: "acp"`.
 *
 * Wraps a subprocess's stdio in an `@agentproto/acp` client and
 * exposes the `AgentCliClient` shape the runner consumes. Each
 * `send()` call delegates to a single AcpClientSession.prompt() and
 * forwards the resulting StreamEvent stream.
 */

import type { ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
  createAcpClient,
  type AcpClient,
  type AcpClientSession,
} from "@agentproto/acp/client"
import type {
  AgentCliClient,
  AgentCliConnectOptions,
  StreamEvent,
} from "../types.js"

/**
 * Outcome the host returns to the agent on a permission request.
 *
 * Mirrors the upstream ACP `RequestPermissionResponse` shape EXACTLY —
 * note the doubly-nested `outcome` field: the outer is the response
 * envelope, the inner is the discriminator (string literal, not a
 * `{ type: ... }` object). Get this wrong and the agent silently
 * interprets the response as a refusal ("User refused permission to
 * run tool"), so we type it strictly here.
 *
 *   { outcome: { outcome: "selected", optionId: "..." } }
 *   { outcome: { outcome: "cancelled" } }
 */
export type AcpPermissionOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } }

export interface AcpPermissionRequestParams {
  sessionId?: string
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
    rawInput?: unknown
  }
  options?: Array<{ optionId: string; name?: string; kind?: string }>
}

export type AcpPermissionHandler = (
  params: AcpPermissionRequestParams
) => Promise<AcpPermissionOutcome> | AcpPermissionOutcome

/**
 * Default handler: pick the first option whose `kind` starts with
 * `allow_` (Claude Code offers `allow_once` and `allow_always`).
 * Falls back to the first option if none match — keeps the agent
 * unblocked rather than throwing on an unfamiliar option set.
 *
 * Mirrors the trust model of in-process Mastra agents: the user
 * approved the operator binding once; subsequent tool calls don't
 * re-prompt by default. Hosts that want explicit per-call gating
 * pass their own `onPermissionRequest`.
 */
export const autoAllowPermissionHandler: AcpPermissionHandler = ({
  options,
}) => {
  if (!options || options.length === 0) {
    // No options offered — return cancelled so the agent gets a
    // deterministic answer instead of hanging on a dropped request.
    return { outcome: { outcome: "cancelled" } }
  }
  const allow =
    options.find(o => typeof o.kind === "string" && o.kind.startsWith("allow_")) ??
    options[0]
  return { outcome: { outcome: "selected", optionId: allow!.optionId } }
}

export interface AcpProtocolOptions {
  child: ChildProcess
  cwd: string
  clientInfo?: { name: string; title?: string; version?: string }
  /** Called when the agent asks for permission to run a tool (Write,
   *  Bash, ...). Defaults to `autoAllowPermissionHandler`. Pass a
   *  custom handler to plumb requests through a UI / governance
   *  policy. Throwing or returning a rejected promise bubbles to the
   *  agent as an internal error. */
  onPermissionRequest?: AcpPermissionHandler
}

export function createAcpProtocolArm(
  options: AcpProtocolOptions,
): AgentCliClient {
  const { child, cwd } = options

  if (!child.stdin || !child.stdout) {
    throw new Error(
      "AcpProtocolArm: subprocess must be spawned with piped stdin + stdout",
    )
  }

  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>

  let client: AcpClient | null = null
  let session: AcpClientSession | null = null
  const pendingByTurn = new Map<string, AsyncIterable<StreamEvent>>()

  return {
    get sessionId(): string | undefined {
      return session?.sessionId
    },
    async connect(opts: AgentCliConnectOptions) {
      const permissionHandler =
        options.onPermissionRequest ?? autoAllowPermissionHandler
      client = await createAcpClient({
        output,
        input,
        clientInfo: options.clientInfo,
        capabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
        onActivity: opts.onActivity,
        turnIdleTimeoutMs: opts.turnIdleTimeoutMs,
        // Wire the permission handler so the agent's `session/request_permission`
        // callbacks get a real answer instead of bubbling up as
        // "AcpClient.requestPermission: no handler configured" → which
        // surfaces in the chat as an opaque "Internal error" when the
        // agent tries to Write / Bash anything gated.
        handlers: {
          requestPermission: async (params: unknown) =>
            permissionHandler(params as AcpPermissionRequestParams),
        } as never,
      })
      // When the host hands us a `resumeSessionId`, reattach to the
      // agent's existing session via `loadSession` so the conversation
      // (model context, tool history, working files) carries over a
      // cold start. We trust the host to only send ids it persisted
      // from a prior turn; if the agent's `loadSession: true` capability
      // wasn't advertised the SDK call surfaces the per-protocol error.
      //
      // No silent fallback to `newSession` on resume failure — that
      // would create a new session quietly and lose continuity, which
      // is the bug we're trying to prevent. Let the error propagate.
      if (opts.resumeSessionId) {
        session = await client.loadSession({
          sessionId: opts.resumeSessionId,
          cwd,
          mcpServers: opts.mcpServers,
        })
      } else {
        session = await client.newSession({
          cwd,
          mcpServers: opts.mcpServers,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
        })
      }
    },
    async send(turnId, message) {
      if (!session) throw new Error("AcpProtocolArm.send: not connected")
      // ACP's `prompt` field is `ContentBlock[]` — multiple blocks
      // together form the user's turn (text + image + resource_link
      // + ...). Callers MAY pass either:
      //   - a single block (`{type:"text",text:"..."}`) — wrapped
      //     into a one-element array for the wire
      //   - an array of blocks — forwarded verbatim, supporting
      //     multimodal turns without callers re-shaping per-arm
      const messages = Array.isArray(message) ? message : [message]
      const stream = session.prompt({ messages })
      pendingByTurn.set(turnId, stream)
    },
    async *events(): AsyncIterable<StreamEvent> {
      const last = Array.from(pendingByTurn.values()).at(-1)
      if (!last) return
      for await (const evt of last) yield evt
    },
    async cancel(_turnId) {
      if (!session) return
      await session.cancel()
    },
    async close() {
      if (session) await session.close()
      if (client) await client.close()
    },
  }
}
