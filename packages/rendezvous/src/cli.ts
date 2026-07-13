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

import { createRendezvousServer, type RendezvousServerOptions } from "./server.js"

interface ServeArgs {
  port: number
  host: string
  parkTimeoutMs?: number
  idleTimeoutMs?: number
  maxMessageBytes?: number
}

const DEFAULT_PORT = 8788
const DEFAULT_HOST = "0.0.0.0"

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

  let args: ServeArgs
  try {
    args = parseServeArgs(argv.slice(1))
  } catch (err) {
    process.stderr.write(
      `agentproto-rendezvous: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }

  const opts: RendezvousServerOptions = {
    onLog: line => process.stderr.write(line + "\n"),
    ...(args.parkTimeoutMs !== undefined ? { parkTimeoutMs: args.parkTimeoutMs } : {}),
    ...(args.idleTimeoutMs !== undefined ? { idleTimeoutMs: args.idleTimeoutMs } : {}),
    ...(args.maxMessageBytes !== undefined ? { maxMessageBytes: args.maxMessageBytes } : {}),
  }
  const server = createRendezvousServer(opts)
  const { port, host } = await server.listen(args.port, args.host)

  process.stdout.write(
    `agentproto-rendezvous listening on ws://${host}:${port}/v1\n` +
      `  clients dial:  ws://<this-host>:${port}/v1?side=client&t=<token>\n` +
      `  daemons dial:  ws://<this-host>:${port}/v1?side=daemon&t=<token>\n` +
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

function parseServeArgs(argv: readonly string[]): ServeArgs {
  let port = DEFAULT_PORT
  let host = DEFAULT_HOST
  let parkTimeoutMs: number | undefined
  let idleTimeoutMs: number | undefined
  let maxMessageBytes: number | undefined

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
    } else if (arg === "--park-timeout-ms") {
      parkTimeoutMs = takeNum(argv[++i], "--park-timeout-ms")
    } else if (arg === "--idle-timeout-ms") {
      idleTimeoutMs = takeNum(argv[++i], "--idle-timeout-ms")
    } else if (arg === "--max-message-bytes") {
      maxMessageBytes = takeNum(argv[++i], "--max-message-bytes")
    } else {
      throw new Error(`unrecognised argument "${arg}"`)
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port — expected an integer 0-65535`)
  }
  return {
    port,
    host,
    ...(parkTimeoutMs !== undefined ? { parkTimeoutMs } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(maxMessageBytes !== undefined ? { maxMessageBytes } : {}),
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
      "Options:",
      `  --port <n>              Port to bind (default ${DEFAULT_PORT}).`,
      `  --host <ip>             Bind address (default ${DEFAULT_HOST}).`,
      "  --park-timeout-ms <n>   How long a lone socket waits for its peer (default 120000).",
      "  --idle-timeout-ms <n>   Idle teardown after splice (default 900000).",
      "  --max-message-bytes <n> Max WS message size (default 1048576).",
      "  --help                  Show this message.",
      "",
      "The broker matches two sockets sharing a token and pipes their bytes",
      "verbatim. It never parses payloads and cannot read or forge traffic.",
    ].join("\n") + "\n",
  )
}

// Direct-exec entry (when run as the `agentproto-rendezvous` bin).
const isMain =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith("/cli.mjs") ||
    import.meta.url.endsWith("/cli.js"))
if (isMain) {
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
