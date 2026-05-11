/**
 * End-to-end tunnel test:
 *   1. WS server (acts as host).
 *   2. Spawn `agentproto serve --connect ws://...` (daemon).
 *   3. After `hello`, drive a child via the tunnel client.
 *   4. Assert stdout payload + exit code arrive intact.
 *
 * Verifies the full stack: cli `serve` verb → tunnel server → child
 * process → stdout frames → tunnel client → host-side ChildProcess
 * duck → exit propagation.
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { afterAll, expect, test } from "vitest"
import { WebSocketServer } from "ws"
import {
  createTunnelClient,
  wrapWebSocket,
} from "@agentproto/acp/tunnel"

// Use two independent random ports in different ranges so neither
// collides with a default daemon (18790) or each other.
const PORT = 19700 + Math.floor(Math.random() * 100)
const GW_PORT = 19800 + Math.floor(Math.random() * 100)

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "cli.mjs"
)

let wss: WebSocketServer | null = null

afterAll(() => {
  wss?.close()
})

test("agentproto serve relays a child process end-to-end", { timeout: 15_000 }, async () => {
    wss = new WebSocketServer({ port: PORT })

    // Capture the host-side flow as a promise that resolves with
    // the result so the test can assert on it.
    const hostFlow = new Promise<{
      stdout: string
      code: number | null
      signal: string | null
    }>((resolve, reject) => {
      wss!.once("connection", async (ws) => {
        try {
          const sink = wrapWebSocket(
            ws as unknown as Parameters<typeof wrapWebSocket>[0]
          )
          const client = createTunnelClient({ sink })
          await client.ready()

          const child = await client.spawn("node", [
            "-e",
            'process.stdout.write("hello-from-tunnel"); process.exit(7)',
          ])

          let stdoutBuf = ""
          child.stdout.on("data", (b: Buffer) => {
            stdoutBuf += b.toString("utf8")
          })

          child.on(
            "exit",
            (code: number | null, signal: string | null) => {
              resolve({ stdout: stdoutBuf, code, signal })
              client.close()
            }
          )
        } catch (err) {
          reject(err)
        }
      })
    })

    const daemon = spawn(
      "node",
      [
        CLI_PATH,
        "serve",
        "--connect",
        `ws://localhost:${PORT}`,
        "--port",
        String(GW_PORT),
        "--label",
        "vitest-e2e",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    )

    // Drain stderr so a failed gateway boot surfaces in the test output
    // instead of silently buffering (which would block on a full OS pipe).
    let daemonStderr = ""
    daemon.stderr?.on("data", (chunk: Buffer) => {
      daemonStderr += chunk.toString("utf8")
    })

    const result = await hostFlow.catch(err => {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\ndaemon stderr:\n${daemonStderr}`
      )
    })
    daemon.kill("SIGTERM")
    await new Promise<void>((r) => daemon.on("exit", () => r()))

    expect(result.stdout).toBe("hello-from-tunnel")
    expect(result.code).toBe(7)
    expect(result.signal).toBeNull()
})
