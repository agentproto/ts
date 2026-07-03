/**
 * Boots the ACP server over stdio — the standard wiring for a spawned ACP
 * agent (mirrors the @agentclientprotocol/sdk agent example): the agent writes
 * JSON-RPC to stdout and reads from stdin.
 */

import { Readable, Writable } from "node:stream"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ClaudeSdkAcpAgent } from "./acp-host.js"
import type { ClaudeSdkConfig } from "./options.js"

export function runAcpOverStdio(
  config: ClaudeSdkConfig = {},
): AgentSideConnection {
  // ndJsonStream(writable, readable): outgoing bytes -> stdout, incoming <- stdin.
  const toClient = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const fromClient = Readable.toWeb(
    process.stdin,
  ) as unknown as ReadableStream<Uint8Array>
  const stream = ndJsonStream(toClient, fromClient)
  return new AgentSideConnection(
    (conn) => new ClaudeSdkAcpAgent(conn, config),
    stream,
  )
}
