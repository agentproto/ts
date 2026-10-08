/**
 * `EventsDaemon` over the daemon's authenticated `/mcp` endpoint.
 *
 * `events/*` are native JSON-RPC methods (not tools), so they go through the
 * SDK client's generic `request`. The result schema is deliberately loose:
 * the daemon's adapter owns validation and returns typed errors.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import type { EventsDaemon } from "./channel.js"

const looseResult = z.object({}).passthrough()

export function createDaemonClient(opts: { url: string; token?: string }): EventsDaemon {
  let connecting: Promise<Client> | undefined
  const connect = (): Promise<Client> => {
    connecting ??= (async () => {
      const client = new Client({ name: "agentproto-events-channel", version: "0.0.1" })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(opts.url), {
          requestInit: { headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {} },
        }),
      )
      return client
    })().catch(error => {
      connecting = undefined
      throw error
    })
    return connecting
  }
  return {
    async request(method, params) {
      const client = await connect()
      return (await client.request({ method, params }, looseResult)) as Record<string, unknown>
    },
  }
}
