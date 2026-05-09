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

export interface AcpProtocolOptions {
  child: ChildProcess
  cwd: string
  clientInfo?: { name: string; title?: string; version?: string }
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
    async connect(_opts: AgentCliConnectOptions) {
      client = await createAcpClient({
        output,
        input,
        clientInfo: options.clientInfo,
        capabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      })
      session = await client.newSession({ cwd })
    },
    async send(turnId, message) {
      if (!session) throw new Error("AcpProtocolArm.send: not connected")
      const stream = session.prompt({ messages: [message] })
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
