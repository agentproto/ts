/**
 * End-to-end: `agentproto hook inbox` against a real in-process runtime
 * gateway + sessions registry. First run touches/registers the Claude
 * Desktop chat's `cc:<id>` row; a normal daemon send deposits a message;
 * the second run reads it back out. No mocks on either side.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, startHttpServer, createRuntimeEvents } from "@agentproto/runtime"
import type { ConversationStore, HeartbeatRunner, SessionsRegistry } from "@agentproto/runtime"

import { runHook } from "../commands/hook.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const conversations: ConversationStore = {
  async open() {},
  async appendTurn() {},
  async read() {
    return { meta: {} as never, turns: [] }
  },
  async list() {
    return []
  },
  pathFor: (id: string) => id,
}
const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }

describe("hook inbox end-to-end against a real gateway", () => {
  let tmp: string
  let registry: SessionsRegistry
  let http: Awaited<ReturnType<typeof startHttpServer>>
  let base: string
  const savedUrl = process.env.AGENTPROTO_DAEMON_URL
  const savedToken = process.env.AGENTPROTO_DAEMON_TOKEN

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "hook-inbox-e2e-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const port = await freePort()
    http = await startHttpServer({
      port,
      auth: { mode: "none" },
      // No /mcp traffic in this test; REST routes never call the factory.
      mcpServerFactory: (async () => ({}) as never) as never,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    base = `http://127.0.0.1:${port}`
    process.env.AGENTPROTO_DAEMON_URL = base
    process.env.AGENTPROTO_DAEMON_TOKEN = "test-token"
  })

  afterEach(async () => {
    if (savedUrl === undefined) delete process.env.AGENTPROTO_DAEMON_URL
    else process.env.AGENTPROTO_DAEMON_URL = savedUrl
    if (savedToken === undefined) delete process.env.AGENTPROTO_DAEMON_TOKEN
    else process.env.AGENTPROTO_DAEMON_TOKEN = savedToken
    await http.stop()
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("registers cc:<id> on the first run and reads a deposit on the next", async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const payload = JSON.stringify({ session_id: "chat-e2e", cwd: tmp })
    const run = () =>
      runHook(["inbox"], {
        readStdin: async () => payload,
        env: {},
        claudeSessionsDir: "/nonexistent-claude-sessions",
        readDir: () => [],
      })

    expect(await run()).toBe(0)
    expect(registry.get("cc:chat-e2e")).toMatchObject({ kind: "external", externalHost: "claude-desktop" })

    const sent = await fetch(`${base}/sessions/cc%3Achat-e2e/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from e2e", urgency: "fyi" }),
    })
    expect(sent.status).toBe(200)

    writes.length = 0
    expect(await run()).toBe(0)
    expect(writes.join("")).toContain("hello from e2e")
  })
})
