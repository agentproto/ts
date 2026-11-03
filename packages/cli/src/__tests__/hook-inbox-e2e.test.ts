import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionsRegistry, startHttpServer, createRuntimeEvents, fileConversationStore } from "@agentproto/runtime"
import type { HeartbeatRunner, SessionsRegistry } from "@agentproto/runtime"
import { runHook } from "../commands/hook.js"
const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }
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

describe("hook inbox end-to-end against a real gateway", () => {
  let tmp: string
  let registry: SessionsRegistry
  let http: Awaited<ReturnType<typeof startHttpServer>>
  let base: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "hook-inbox-e2e-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const port = await freePort()
    http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: (async () => ({}) as never) as never,
      conversations: fileConversationStore({ workspace: tmp }),
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    base = `http://127.0.0.1:${port}`
    vi.stubEnv("AGENTPROTO_DAEMON_URL", base)
    vi.stubEnv("AGENTPROTO_DAEMON_TOKEN", "test-token")
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
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
    const run = () => runHook(["inbox"], { readStdin: async () => payload, env: {}, readDir: () => [] })

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
