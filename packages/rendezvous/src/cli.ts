#!/usr/bin/env node
/**
 * `agentproto-rendezvous` — the standalone broker binary.
 *
 *   agentproto-rendezvous serve [--port <n>] [--host <ip>]
 *
 * Self-hostable single binary (design DESIGN §3): run your own rendezvous so no
 * third party — not even the default hosted instance — sits between your client
 * and daemon. The broker only ever sees ciphertext, so this is defence in depth
 * rather than a trust requirement, but the escape hatch matters.
 *
 * Also surfaced as `agentproto rendezvous serve` from the main CLI (a thin
 * re-export), so users don't need this bin on their PATH.
 */

import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { createRendezvousServer, type RendezvousServerOptions } from "./server.js"
import { loadEnvConfig, type RendezvousEnvConfig } from "./env.js"

interface ServeArgs {
  port: number
  host: string
  path: string
  parkTimeoutMs?: number
  idleTimeoutMs?: number
  maxMessageBytes?: number
  rateLimitMax: number
  rateLimitWindowMs: number
  debug: boolean
}

const DEFAULT_PORT = 8788
const DEFAULT_HOST = "0.0.0.0"

function mergeConfigWithEnv(cliArgs: Partial<ServeArgs>): ServeArgs {
  const env = loadEnvConfig()
  return {
    port: cliArgs.port ?? env.port,
    host: cliArgs.host ?? env.host,
    path: cliArgs.path ?? env.path,
    parkTimeoutMs: cliArgs.parkTimeoutMs ?? env.parkTimeoutMs,
    idleTimeoutMs: cliArgs.idleTimeoutMs ?? env.idleTimeoutMs,
    maxMessageBytes: cliArgs.maxMessageBytes ?? env.maxMessageBytes,
    rateLimitMax: cliArgs.rateLimitMax ?? env.rateLimitMax,
    rateLimitWindowMs: cliArgs.rateLimitWindowMs ?? env.rateLimitWindowMs,
    debug: cliArgs.debug ?? env.debug,
  }
}

export async function runRendezvousCli(argv: readonly string[]): Promise<number> {
  const sub = argv[0]
  if (sub === "--help" || sub === "-h" || sub === "help" || sub === undefined) {
    printHelp()
    return 0
  }
  if (sub !== "serve") {
    process.stderr.write(`agentproto-rendezvous: unknown subcommand "${sub}"\n\n`)
    printHelp()
    return 2
  }

  let args: Partial<ServeArgs>
  try {
    args = parseServeArgs(argv.slice(1))
  } catch (err) {
    process.stderr.write(
      `agentproto-rendezvous: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }

  // CLI args take precedence over env vars
  const merged = mergeConfigWithEnv(args)

  const opts: RendezvousServerOptions = {
    onLog: line => process.stderr.write(line + "\n"),
    path: merged.path,
    ...(merged.parkTimeoutMs !== undefined ? { parkTimeoutMs: merged.parkTimeoutMs } : {}),
    ...(merged.idleTimeoutMs !== undefined ? { idleTimeoutMs: merged.idleTimeoutMs } : {}),
    ...(merged.maxMessageBytes !== undefined ? { maxMessageBytes: merged.maxMessageBytes } : {}),
    rateLimit: { max: merged.rateLimitMax, windowMs: merged.rateLimitWindowMs },
  }
  const server = createRendezvousServer(opts)
  const { port, host } = await server.listen(merged.port, merged.host)

  if (merged.debug) {
    process.stderr.write(
      "[debug] effective config: " +
        JSON.stringify({
          port,
          host,
          path: merged.path,
          parkTimeoutMs: merged.parkTimeoutMs,
          idleTimeoutMs: merged.idleTimeoutMs,
          maxMessageBytes: merged.maxMessageBytes,
          rateLimitMax: merged.rateLimitMax,
          rateLimitWindowMs: merged.rateLimitWindowMs,
        }) +
        "\n",
    )
  }

  process.stdout.write(
    `agentproto-rendezvous listening on ws://${host}:${port}${merged.path}\n` +
      `  clients dial:  ws://<this-host>:${port}${merged.path}?side=client&t=<token>\n` +
      `  daemons dial:  ws://<this-host>:${port}${merged.path}?side=daemon&t=<token>\n` +
      `  the broker only ever sees ciphertext — token, IPs, sizes, timing.\n`,
  )

  await new Promise<void>(resolve => {
    const shutdown = (signal: string): void => {
      process.stderr.write(`\nreceived ${signal}, shutting down…\n`)
      void server.close().finally(() => resolve())
    }
    process.once("SIGINT", () => shutdown("SIGINT"))
    process.once("SIGTERM", () => shutdown("SIGTERM"))
  })
  return 0
}

function parseServeArgs(argv: readonly string[]): Partial<ServeArgs> {
  let port: number | undefined
  let host: string | undefined
  let path: string | undefined
  let parkTimeoutMs: number | undefined
  let idleTimeoutMs: number | undefined
  let maxMessageBytes: number | undefined
  let rateLimitMax: number | undefined
  let rateLimitWindowMs: number | undefined
  let debug: boolean | undefined

  const takeNum = (raw: string | undefined, flag: string): number => {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`invalid value for ${flag}`)
    return n
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--port" || arg === "-p") {
      port = takeNum(argv[++i], "--port")
    } else if (arg?.startsWith("--port=")) {
      port = takeNum(arg.slice("--port=".length), "--port")
    } else if (arg === "--host" || arg === "-H") {
      host = argv[++i] ?? host
    } else if (arg?.startsWith("--host=")) {
      host = arg.slice("--host=".length)
    } else if (arg === "--path") {
      path = argv[++i] ?? path
    } else if (arg?.startsWith("--path=")) {
      path = arg.slice("--path=".length)
    } else if (arg === "--park-timeout-ms") {
      parkTimeoutMs = takeNum(argv[++i], "--park-timeout-ms")
    } else if (arg === "--idle-timeout-ms") {
      idleTimeoutMs = takeNum(argv[++i], "--idle-timeout-ms")
    } else if (arg === "--max-message-bytes") {
      maxMessageBytes = takeNum(argv[++i], "--max-message-bytes")
    } else if (arg === "--rate-limit-max") {
      rateLimitMax = takeNum(argv[++i], "--rate-limit-max")
    } else if (arg === "--rate-limit-window-ms") {
      rateLimitWindowMs = takeNum(argv[++i], "--rate-limit-window-ms")
    } else if (arg === "--debug") {
      debug = true
    } else {
      throw new Error(`unrecognised argument "${arg}"`)
    }
  }

  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`invalid --port — expected an integer 0-65535`)
  }
  return {
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(parkTimeoutMs !== undefined ? { parkTimeoutMs } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(maxMessageBytes !== undefined ? { maxMessageBytes } : {}),
    ...(rateLimitMax !== undefined ? { rateLimitMax } : {}),
    ...(rateLimitWindowMs !== undefined ? { rateLimitWindowMs } : {}),
    ...(debug !== undefined ? { debug } : {}),
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "agentproto-rendezvous — untrusted ciphertext splicer for E2E daemon pairing.",
      "",
      "Usage:",
      "  agentproto-rendezvous serve [options]",
      "",
      "Options (CLI args take precedence over environment variables):",
      `  --port <n>              Port to bind (default ${DEFAULT_PORT}, env: RENDEZVOUS_PORT).`,
      `  --host <ip>             Bind address (default ${DEFAULT_HOST}, env: RENDEZVOUS_HOST).`,
      "  --path <p>              Upgrade path the broker listens on (default /v1, env: RENDEZVOUS_PATH).",
      "  --park-timeout-ms <n>   How long a lone socket waits for its peer (default 120000, env: RENDEZVOUS_PARK_TIMEOUT_MS).",
      "  --idle-timeout-ms <n>   Idle teardown after splice (default 900000, env: RENDEZVOUS_IDLE_TIMEOUT_MS).",
      "  --max-message-bytes <n> Max WS message size (default 1048576, env: RENDEZVOUS_MAX_MESSAGE_BYTES).",
      "  --rate-limit-max <n>    Max upgrade attempts per IP per window (default 120, env: RENDEZVOUS_RATE_LIMIT_MAX).",
      "  --rate-limit-window-ms <n>  Rate-limit window (default 60000, env: RENDEZVOUS_RATE_LIMIT_WINDOW_MS).",
      "  --debug                 Print the effective config at startup (env: RENDEZVOUS_DEBUG).",
      "  --help                  Show this message.",
      "",
      "Environment variables:",
      "  RENDEZVOUS_PORT, RENDEZVOUS_HOST, RENDEZVOUS_PATH",
      "  RENDEZVOUS_PARK_TIMEOUT_MS, RENDEZVOUS_IDLE_TIMEOUT_MS",
      "  RENDEZVOUS_MAX_MESSAGE_BYTES, RENDEZVOUS_RATE_LIMIT_MAX",
      "  RENDEZVOUS_RATE_LIMIT_WINDOW_MS, RENDEZVOUS_DEBUG",
      "",
      "The broker matches two sockets sharing a token and pipes their bytes",
      "verbatim. It never parses payloads and cannot read or forge traffic.",
    ].join("\n") + "\n",
  )
}

// Direct-exec entry (only when run AS the `agentproto-rendezvous` bin, never
// when imported as a library — e.g. the main CLI's `rendezvous serve`
// re-export imports `@agentproto/rendezvous/cli`, and must NOT trigger a run).
// Compare this module against argv[1]'s realpath: a bin symlink still resolves
// to this file, while any library import resolves to a different entrypoint.
// (A plain `endsWith("/cli.mjs")` check matched every imported copy of this
// module, printing the broker help onto the importer's stdout.)
function invokedAsMain(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}
if (invokedAsMain()) {
  runRendezvousCli(process.argv.slice(2)).then(
    code => {
      process.exitCode = code
    },
    err => {
      process.stderr.write(
        `agentproto-rendezvous: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      )
      process.exitCode = 1
    },
  )
}
