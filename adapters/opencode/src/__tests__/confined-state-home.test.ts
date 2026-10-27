/**
 * A confined opencode spawn (a workflow agent step under an app boundary)
 * must get a WRITABLE state home.
 *
 * opencode keeps the lock/state store its MCP client registers
 * `session/new.mcpServers` entries through in `$XDG_STATE_HOME/opencode`.
 * The app-boundary sandbox denies `$HOME`, so with the ambient
 * `~/.local/state` the store cannot be created: opencode still completes the
 * ACP handshake and runs with its native tools, but SILENTLY drops the
 * daemon mount (no `agentproto_*` tool, no error on the wire). Pointing
 * `XDG_STATE_HOME` at the session config dir (and granting it writable) is
 * what keeps the mount alive. See the maintain/reviewOne sessions that
 * hand-posted JSON-RPC instead of calling `branch_gc_verdict`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { execSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { opencode } from "../index.js"

const spawnCalls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = []

/**
 * A minimal ACP stdio server: enough for the driver's handshake (initialize
 * + session/new) so `runtime.start()` resolves without a real CLI or model.
 */
function fakeAcpChild(): ChildProcess {
  const input = new PassThrough()
  const output = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin: input,
    stdout: output,
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  }) as unknown as ChildProcess

  let buf = ""
  input.on("data", (chunk: Buffer) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number; method?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id === undefined || !msg.method) continue
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } },
              authMethods: [],
            }
          : msg.method === "session/new" || msg.method === "session/load"
            ? { sessionId: "sess-1", configOptions: [] }
            : {}
      output.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n")
    }
  })
  queueMicrotask(() => child.emit("spawn"))
  return child
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: vi.fn((bin: string, args: string[], opts: { env: Record<string, string> }) => {
      spawnCalls.push({ bin, args, env: opts.env })
      return fakeAcpChild()
    }),
  }
})

const { createAgentCliRuntime } = await import(
  "../../../../packages/harness/src/define-agent-cli.js"
)

/** The driver refuses a confined spawn when no OS sandbox backend exists. */
function backendAvailable(): boolean {
  try {
    execSync(process.platform === "darwin" ? "command -v sandbox-exec" : "command -v bwrap", {
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

describe("opencode confined state home", () => {
  let prevStateHome: string | undefined
  let base: string

  beforeEach(() => {
    spawnCalls.length = 0
    prevStateHome = process.env.XDG_STATE_HOME
    delete process.env.XDG_STATE_HOME
    base = realpathSync(mkdtempSync(join(tmpdir(), "opencode-confined-state-")))
  })

  afterEach(() => {
    if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = prevStateHome
    rmSync(base, { recursive: true, force: true })
  })

  it.runIf(backendAvailable())(
    "points XDG_STATE_HOME at the session config dir and grants it writable",
    async () => {
      const app = join(base, "app")
      const runWs = join(base, "runs", "r1")
      const configDir = join(base, "adapter-config", "sess_1")
      for (const d of [app, runWs]) mkdirSync(d, { recursive: true })

      const runtime = createAgentCliRuntime(opencode)
      await runtime.start({
        cwd: app,
        configDir,
        fsZones: { readOnly: [], writable: [runWs] },
      })

      const call = spawnCalls[0]!
      // The bug: no isolation left opencode on ~/.local/state, which the
      // boundary denies, and its MCP client then dropped the daemon mount.
      expect(call.env.XDG_STATE_HOME).toBe(configDir)

      expect(["sandbox-exec", "bwrap"]).toContain(call.bin)
      if (call.bin === "sandbox-exec") {
        expect(call.args.join("\n")).toContain(
          `(allow file-read* file-write* (subpath "${configDir}"))`,
        )
      } else {
        expect(call.args).toContain(configDir)
      }
    },
  )
})
