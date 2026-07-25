#!/usr/bin/env node
/**
 * Narrow public ingress proxy for Telegram bot webhooks.
 *
 * Forwards ONLY `POST /inbound/*` to the local daemon. Rejects every other
 * path or method with 404/405. See docs/TRANSMITTER.md for the full security
 * rationale.
 *
 * Usage:
 *   pnpm --filter @agentproto/runtime telegram:proxy
 *   pnpm --filter @agentproto/runtime telegram:proxy -- --port 8080 --target http://127.0.0.1:18790
 *
 * Environment variables (overridden by CLI flags):
 *   TELEGRAM_PROXY_PORT   — port to listen on (default 8080)
 *   TELEGRAM_PROXY_TARGET — daemon base URL (default http://127.0.0.1:18790)
 */

import { createTelegramProxy } from "../dist/telegram-proxy.mjs"

function parseArgs() {
  const out = {}
  for (const raw of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(raw)
    if (match) {
      out[match[1]] = match[2]
      continue
    }
    const bare = /^--([^=]+)$/.exec(raw)
    if (bare) {
      const next = process.argv[process.argv.indexOf(raw) + 1]
      if (next && !next.startsWith("--")) out[bare[1]] = next
    }
  }
  return out
}

function opt(args, flag, envVar, fallback) {
  if (args[flag] !== undefined) return args[flag]
  if (process.env[envVar] !== undefined) return process.env[envVar]
  return fallback
}

async function main() {
  const args = parseArgs()
  const port = Number(opt(args, "port", "TELEGRAM_PROXY_PORT", 8080))
  const target = opt(
    args,
    "target",
    "TELEGRAM_PROXY_TARGET",
    "http://127.0.0.1:18790",
  )

  const proxy = createTelegramProxy({
    targetBaseUrl: target,
    listenPort: port,
    log: msg => console.log(msg),
  })

  const { url } = await proxy.start()
  console.log(`[telegram-proxy] forwarding POST /inbound/* -> ${target}/inbound/*`)
  console.log(`[telegram-proxy] listening on ${url}`)
  console.log(`[telegram-proxy] tunnel with: cloudflared tunnel --url ${url}`)

  process.on("SIGINT", async () => {
    console.log("\n[telegram-proxy] shutting down...")
    await proxy.stop()
    process.exit(0)
  })

  process.on("SIGTERM", async () => {
    await proxy.stop()
    process.exit(0)
  })
}

main().catch(err => {
  console.error("[telegram-proxy] fatal error:", err)
  process.exit(1)
})
