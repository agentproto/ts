/**
 * Regression test for the mcp-bridge orphan leak.
 *
 * A stdio MCP host (Codex, Cursor, Claude Desktop, an agent CLI, …) spawns
 * `agentproto mcp-bridge` as a child and talks to it over stdin/stdout. When
 * the host goes away, the bridge's stdin reaches EOF — the signal that its
 * stdio peer is gone. The bridge used to ignore that EOF and park forever,
 * kept alive by the HTTP client transport, so it outlived its parent and
 * accumulated (one per session) until the host swapped (45 orphans, ~4 GB).
 *
 * This spawns the real built CLI against a fake daemon, closes its stdin, and
 * requires the bridge to exit on its own. Before the fix it stays alive until
 * the timeout kills it, so the test fails.
 */

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "cli.mjs",
)

interface FakeDaemon {
  url: string
  close: () => Promise<void>
}

/** Minimal stateless MCP endpoint — enough for the bridge's connect + listTools. */
async function startFakeDaemon(): Promise<FakeDaemon> {
  const server = createServer(async (req, res) => {
    if (req.url?.split("?")[0] !== "/mcp") {
      res.writeHead(404).end()
      return
    }
    const mcp = new McpServer({ name: "fake-daemon", version: "0.0.0" })
    mcp.tool("ping", "Ping", async () => ({
      content: [{ type: "text", text: "pong" }],
    }))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    res.on("close", () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    let body = ""
    for await (const chunk of req) body += chunk
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Wait until the bridge announces it is connected and parked on stdio. */
function waitForReady(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ""
    const timer = setTimeout(() => {
      reject(new Error(`bridge never became ready; stderr:\n${stderr}`))
    }, timeoutMs)
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
      if (/proxying \d+ tool\(s\) over stdio/.test(stderr)) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once("exit", code => {
      clearTimeout(timer)
      reject(new Error(`bridge exited early (code ${code}); stderr:\n${stderr}`))
    })
  })
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `bridge still alive ${timeoutMs}ms after its stdin closed — orphaned`,
        ),
      )
    }, timeoutMs)
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

let child: ChildProcess | undefined
let daemon: FakeDaemon | undefined
let fakeHome: string | undefined
let holder: ChildProcess | undefined
let extraPids: number[] = []

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
  }
  child = undefined
  holder?.kill("SIGKILL")
  holder = undefined
  for (const pid of extraPids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  extraPids = []
  await daemon?.close()
  daemon = undefined
  if (fakeHome) await rm(fakeHome, { recursive: true, force: true })
  fakeHome = undefined
})

test(
  "exits on its own when the stdio peer closes stdin (no orphan)",
  { timeout: 20_000 },
  async () => {
    daemon = await startFakeDaemon()
    fakeHome = await mkdtemp(join(tmpdir(), "agentproto-mcp-bridge-home-"))
    child = spawn(process.execPath, [CLI_PATH, "mcp-bridge"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: fakeHome,
        AGENTPROTO_MCP_URL: daemon.url,
      },
    })

    await waitForReady(child)

    // The host is gone: its end of the stdio pipe closes, so the bridge sees EOF.
    child.stdin?.end()

    const { code, signal } = await waitForExit(child, 5_000)
    expect(signal).toBeNull()
    expect(code).toBe(0)
  },
)

function waitForProcessGone(pid: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      try {
        process.kill(pid, 0)
      } catch {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`pid ${pid} still alive ${timeoutMs}ms after its parent died — orphaned`))
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/**
 * The incident shape: the host does NOT hold the bridge's stdin itself. It
 * spawns the bridge on a descriptor whose write end lives in a longer-lived
 * sibling (an agent host or daemon pipe), then dies. Stdin therefore never
 * reaches EOF, and `ppid` is the only portable evidence that the parent is
 * gone. The bridge must notice the reparenting and exit on its own.
 */
test.skipIf(process.platform === "win32")(
  "exits on its own when the parent dies but stdin stays open",
  { timeout: 25_000 },
  async () => {
    daemon = await startFakeDaemon()
    fakeHome = await mkdtemp(join(tmpdir(), "agentproto-mcp-bridge-home-"))
    const fifo = join(fakeHome, "stdin.fifo")
    execFileSync("mkfifo", [fifo])

    // Holds the FIFO's write end for the whole test: stdin never sees EOF.
    holder = spawn(process.execPath, [
      "-e",
      "const fs=require('node:fs'); fs.openSync(process.argv[1], 'w'); setInterval(()=>{}, 1000)",
      fifo,
    ])

    const hostScript = [
      "const { spawn } = require('node:child_process')",
      "const fs = require('node:fs')",
      "const [fifo, cli] = process.argv.slice(1)",
      "const fd = fs.openSync(fifo, 'r')",
      "const child = spawn(process.execPath, [cli, 'mcp-bridge'], { stdio: [fd, 'ignore', 'pipe'] })",
      "fs.closeSync(fd)",
      "process.stdout.write(`Pid=${child.pid}\\n`)",
      "child.stderr.on('data', d => {",
      "  if (/proxying \\d+ tool\\(s\\) over stdio/.test(String(d))) setTimeout(() => process.exit(0), 100)",
      "})",
      "setTimeout(() => process.exit(2), 10000)",
    ].join("\n")

    const host = spawn(process.execPath, ["-e", hostScript, fifo, CLI_PATH], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: fakeHome, AGENTPROTO_MCP_URL: daemon.url },
    })
    let hostOut = ""
    let hostErr = ""
    host.stdout?.on("data", (b: Buffer) => (hostOut += b.toString("utf8")))
    host.stderr?.on("data", (b: Buffer) => (hostErr += b.toString("utf8")))
    const hostExit = await new Promise<number | null>(resolve =>
      host.once("exit", code => resolve(code)),
    )
    expect(hostExit, hostErr).toBe(0)

    const bridgePid = Number(/Pid=(\d+)/.exec(hostOut)?.[1])
    expect(bridgePid).toBeGreaterThan(0)
    extraPids.push(bridgePid)

    await waitForProcessGone(bridgePid, 8_000)
  },
)
