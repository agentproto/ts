/**
 * T15 wiring proof on the real gateway: `/mcp?callerSessionId=` resolves the
 * caller once per request and hands it to the file, memory, app-data and brain
 * tools. A caller the daemon does not know is refused, a sealed sibling's file
 * is absent, a request with no caller id stays a host call. Real `createGateway`
 * with an isolated HOME and the shared fixture; nothing persisted.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { GatewayHandle } from "../index.js"
import type { AgentSessionLike } from "../sessions.js"
import { buildCallerFixture, type CallerFixture } from "./caller-scope-fixture.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

let home = ""
let fx: CallerFixture
let gateway: GatewayHandle
const ids: { perso: string; notes: string } = { perso: "", notes: "" }

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "caller-scope-gateway-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("AGENTPROTO_HOME", join(home, ".agentproto"))
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

beforeEach(async () => {
  fx = buildCallerFixture()
  const { createGateway } = await import("../index.js")
  gateway = await createGateway({
    workspace: fx.user.root,
    specs: [],
    port: await freePort(),
    boot: false,
    persist: false,
    persistPath: join(home, "sessions.json"),
  })
  const agentSession = (): AgentSessionLike =>
    ({ sessionId: "acp", async *send() {}, async cancel() {}, async close() {} }) as AgentSessionLike
  const spawn = (cwd: string) =>
    gateway.sessions.spawnAgent({ workspaceSlug: "default", cwd, agentSession: agentSession(), adapterSlug: "mock" }).id
  ids.perso = spawn(fx.user.persoJournal)
  ids.notes = spawn(fx.user.notes)
})
afterEach(async () => {
  await gateway.stop()
  fx.cleanup()
})

async function call(callerId: string | undefined, tool: string, args: Record<string, unknown>) {
  const url = new URL(`${gateway.url}/mcp${callerId !== undefined ? `?callerSessionId=${encodeURIComponent(callerId)}` : ""}`)
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(url))
  try {
    const r = (await client.callTool({ name: tool, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") }
  } finally {
    await client.close()
  }
}

describe("the gateway hands each request's caller to the read tools", () => {
  it("file_read: the sealed node reads its own file, its sibling and a host call differ as the walls say", async () => {
    const own = await call(ids.perso, "file_read", { path: "perso/diary.txt" })
    expect(own.isError).toBe(false)
    expect(own.text).toContain("PERSO-DIARY")

    const sibling = await call(ids.notes, "file_read", { path: "perso/diary.txt" })
    expect(sibling.isError).toBe(true)
    expect(sibling.text).not.toContain("PERSO-DIARY")

    const host = await call(undefined, "file_read", { path: "perso/diary.txt" })
    expect(host.isError).toBe(false)
    expect(host.text).toContain("PERSO-DIARY")
  })

  it("directory_list: the sibling does not see the sealed node's entries", async () => {
    const sibling = await call(ids.notes, "directory_list", { path: "." })
    expect(sibling.text).toContain("notes")
    expect(sibling.text).not.toContain("perso")
  })

  for (const [tool, args] of [
    ["file_read", { path: "root.txt" }],
    ["memory_list", {}],
    ["memory_search", { query: "x" }],
    ["app_data_list", { appId: "@me/todo" }],
    ["workspace_brain_status", {}],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`${tool}: a caller id the daemon does not know is refused`, async () => {
      const res = await call("sess_not_registered", tool, args)
      expect(res.isError).toBe(true)
      expect(res.text).toMatch(/refused/i)
    })
  }

  it("a request with no caller id stays a host call", async () => {
    const res = await call(undefined, "file_read", { path: "root.txt" })
    expect(res.isError).toBe(false)
    expect(res.text).toContain("ROOT-ABOVE-THE-WALL")
  })
})
