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
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { afterAll, expect, test } from "vitest"
import { WebSocketServer } from "ws"
import {
  createTunnelClient,
  wrapWebSocket,
} from "@agentproto/acp/tunnel"

// Kernel-assigned ephemeral ports, not a fixed range. The old
// `19700 + random(0..99)` only had 100 slots, so two worktrees running this
// suite in parallel collided by the birthday bound and one daemon died with
// `EADDRINUSE`. `port: 0` on the WS server (read back below) and a throwaway
// listener for the gateway port let the OS hand out ports nothing else holds.
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "cli.mjs"
)

let wss: WebSocketServer | null = null
// Isolated HOME for the spawned daemon. `os.homedir()` reads $HOME on
// POSIX, and every ~/.agentproto/ state path resolves off it — so without
// this the child daemon persists its `vitest-e2e` session rows into the
// developer's REAL ~/.agentproto/sessions.json, where the next real daemon
// boot reloads them as history. Isolating the PORT (above) is not enough:
// the state file is shared regardless of port.
let fakeHome: string | null = null

afterAll(async () => {
  wss?.close()
  if (fakeHome) await rm(fakeHome, { recursive: true, force: true })
})

test("agentproto serve relays a child process end-to-end", { timeout: 15_000 }, async () => {
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss!.once("listening", () => r()))
    const port = (wss.address() as AddressInfo).port
    const gwPort = await freePort()
    fakeHome = await mkdtemp(join(tmpdir(), "agentproto-tunnel-e2e-home-"))

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
        `ws://localhost:${port}`,
        "--port",
        String(gwPort),
        "--label",
        "vitest-e2e",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // Keep the rest of the environment (PATH, node flags) — only the
        // home the daemon writes its state under is redirected.
        env: { ...process.env, HOME: fakeHome },
      }
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
