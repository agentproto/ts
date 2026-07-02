#!/usr/bin/env node
/**
 * `agentproto-relay` — the standalone binary.
 *
 *   agentproto-relay --port 8790 [--tunnel]
 *
 * Reads its target session, delivery mode, bearer token, and daemon
 * URL from env (see config.ts / the package README). `--tunnel` asks
 * the daemon to spawn a public cloudflared quick tunnel for `--port`
 * and prints the URL to paste into whatever external system delivers
 * the webhook.
 */

import { loadConfigFromEnv } from "./config.js"
import { createRelayServer } from "./server.js"

interface CliArgs {
  port: number
  tunnel: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let port = 8790
  let tunnel = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--port") {
      const value = argv[++i]
      port = Number(value)
    } else if (arg?.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length))
    } else if (arg === "--tunnel") {
      tunnel = true
    } else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --port value — expected an integer 1-65535`)
  }
  return { port, tunnel }
}

function printHelp(): void {
  console.log(
    [
      "agentproto-relay — wake one pre-configured agentproto session from an external webhook.",
      "",
      "Usage:",
      "  agentproto-relay --port <port> [--tunnel]",
      "",
      "Options:",
      "  --port <n>   Local port to bind (default 8790).",
      "  --tunnel     Also spawn a public cloudflared quick tunnel for --port via the",
      "               daemon's tunnel_create, and print the public /relay/inbound URL.",
      "  --help       Show this message.",
      "",
      "Required env vars: AGENTPROTO_RELAY_TARGET_SESSION, AGENTPROTO_RELAY_TOKEN.",
      "See the package README for the full list.",
    ].join("\n"),
  )
}

interface TunnelDescriptorLike {
  publicUrl?: unknown
  status?: unknown
}

async function createPublicTunnel(daemonUrl: string, port: number): Promise<string> {
  const res = await fetch(`${daemonUrl}/tunnels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetPort: port, label: "agentproto-relay" }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`failed to create tunnel: HTTP ${res.status} ${text}`)
  }
  const desc = (await res.json()) as TunnelDescriptorLike
  if (typeof desc.publicUrl !== "string" || !desc.publicUrl) {
    throw new Error(`daemon did not return a publicUrl: ${JSON.stringify(desc)}`)
  }
  return desc.publicUrl
}

async function main(): Promise<void> {
  const { port, tunnel } = parseArgs(process.argv.slice(2))
  const config = loadConfigFromEnv(process.env)

  const server = createRelayServer({ config })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })

  console.log(`agentproto-relay listening on http://127.0.0.1:${port}`)
  console.log(`  target session : ${config.targetSession} (via ${config.targetVia})`)
  console.log(`  daemon         : ${config.daemonUrl}`)
  console.log(
    `  rate limit     : ${config.rateLimit.max} requests / ${config.rateLimit.windowMs}ms`,
  )

  if (tunnel) {
    console.log("")
    console.log(`creating public tunnel for port ${port}...`)
    const publicUrl = await createPublicTunnel(config.daemonUrl, port)
    console.log("")
    console.log("Public relay URL — paste this into whatever external system sends the webhook:")
    console.log(`  ${publicUrl}/relay/inbound`)
    console.log("")
  }

  const shutdown = (signal: string): void => {
    console.log(`\nreceived ${signal}, shutting down...`)
    server.close(() => process.exit(0))
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
