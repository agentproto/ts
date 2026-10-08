/**
 * `agentproto-events-channel` — stdio entry for Claude Code.
 *
 * Register as an MCP server and start Claude Code with
 * `--dangerously-load-development-channels server:<name>` (channels are a
 * research preview). Env:
 *
 *   AGENTPROTO_EVENTS_URL    daemon MCP endpoint (default http://127.0.0.1:18790/mcp)
 *   AGENTPROTO_EVENTS_TOKEN  daemon bearer token
 *   EVENTS_CALLBACK_BASE     public https base reaching the receiver; unset = cloudflared quick tunnel
 *   EVENTS_LISTEN_PORT       local receiver port (default: random)
 *   EVENTS_SUBSCRIBE         JSON array of {name, arguments, ttlMs?} to subscribe at startup
 */

import { randomBytes } from "node:crypto"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createEventsChannel, type SubscribeArgs } from "./channel.js"
import { createDaemonClient } from "./daemon-client.js"
import { startReceiver } from "./receiver.js"
import { staticPublicBase, startQuickTunnel, type PublicBase } from "./tunnel.js"

// stdout is the MCP stream; diagnostics go to stderr.
const log = (line: string) => process.stderr.write(`[events-channel] ${line}\n`)

const hookPath = `/hook/${randomBytes(18).toString("base64url")}`
let publicBase: PublicBase | undefined

const channel = createEventsChannel({
  daemon: createDaemonClient({
    url: process.env.AGENTPROTO_EVENTS_URL ?? "http://127.0.0.1:18790/mcp",
    token: process.env.AGENTPROTO_EVENTS_TOKEN,
  }),
  hookPath,
  publicBase: () => {
    if (!publicBase) throw new Error("receiver not started")
    return publicBase.base
  },
  log,
})

const receiver = await startReceiver({
  hookPath,
  port: Number(process.env.EVENTS_LISTEN_PORT ?? 0),
  handle: input => channel.handleDelivery(input),
})
publicBase = process.env.EVENTS_CALLBACK_BASE
  ? staticPublicBase(process.env.EVENTS_CALLBACK_BASE)
  : startQuickTunnel({ localPort: receiver.port, probePath: hookPath, log })
// Warm the tunnel at launch: its 1-2 minute edge warm-up must never land inside a tool call.
publicBase.base.catch(error => log(`public callback not available: ${error instanceof Error ? error.message : String(error)}`))

await channel.server.connect(new StdioServerTransport())
log(`ready; receiver on 127.0.0.1:${receiver.port}`)

if (process.env.EVENTS_SUBSCRIBE) {
  for (const spec of JSON.parse(process.env.EVENTS_SUBSCRIBE) as SubscribeArgs[]) {
    channel.subscribe(spec).then(
      result => log(`subscribed ${String(result.id)}`),
      error => log(`startup subscribe failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }
}

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  await channel.close().catch(() => {})
  publicBase?.stop()
  await receiver.close().catch(() => {})
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.stdin.on("close", shutdown) // Claude Code closed the stdio pipe
