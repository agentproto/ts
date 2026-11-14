/**
 * agentproto/ts#2661: an ACP adapter lists the /mcp gateway's tools inside
 * `startSession`, before the descriptor is registered. The spawn stages the
 * caller context the gateway reads (meta, opt-in, deny grants) for that
 * window, and clears it once the descriptor exists or the start fails.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { spawningCallerContext, type SpawningCallerContext } from "../spawning-caller-context.js"

const fakeSession = (): AgentSessionLike => ({
  sessionId: "adapter_spawning_caller_test",
  // eslint-disable-next-line require-yield
  async *send() {},
  async cancel() {},
  async close() {},
})

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-spawning-caller-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

async function writeAgent(): Promise<string> {
  const dir = join(home, ".agents", "emploi")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "AGENT.md")
  const fm = ["---", "schema: agent/v1", "id: emploi", "description: probe", "model: test-model"]
  const tools = ["tools:", "  - kind: mcp", "    server: agentproto", "    allow: [bureau_click]", "    deny: [cron_create]"]
  await writeFile(path, [...fm, ...tools, "---", "", "You are a probe."].join("\n"), "utf8")
  return path
}

async function setup(start: (args: unknown) => Promise<AgentSessionLike>) {
  const registry = createSessionsRegistry({ persist: false })
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: start as never,
    commandPreview: "mock-adapter",
  })
  const server = new McpServer({ name: "spawning-caller-server", version: "0.0.0" })
  registerAgentTools(server, { registry, resolveAgentAdapter })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "spawning-caller-client", version: "0.0.0" })
  await client.connect(clientTransport)
  const agentStart = async (agentPath: string) => {
    const r = (await client.callTool({ name: "agent_start", arguments: { adapter: "mock", cwd: home, agentPath } })) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    return { isError: r.isError === true, text: r.content.map(c => c.text).join("\n") }
  }
  return { registry, agentStart }
}

/** The minted session id, read from the per-session config dir the spawn passes the driver. */
const mintedIdOf = (args: unknown): string => {
  const m = /sess_[0-9a-z]+/.exec(JSON.stringify(args))
  if (!m) throw new Error("no minted session id in the start args")
  return m[0]
}

describe("the caller context of a session whose driver is starting", () => {
  it("is served while startSession runs (when the adapter lists the gateway's tools) and cleared once registered", async () => {
    const agentPath = await writeAgent()
    let seen: { id: string; registered: boolean; ctx: SpawningCallerContext | undefined } | undefined
    const { registry, agentStart } = await setup(async args => {
      const id = mintedIdOf(args)
      seen = { id, registered: registry.get(id) !== undefined, ctx: spawningCallerContext(id) }
      return fakeSession()
    })
    const res = await agentStart(agentPath)
    expect(res.isError, res.text).toBe(false)

    expect(seen?.registered).toBe(false)
    expect(seen?.ctx?.meta?.agentManifestPath).toBe(agentPath)
    expect(seen?.ctx?.exposedToolOptIn).toEqual(["bureau_click"])
    expect(seen?.ctx?.toolDenyGrants).toHaveLength(1)
    expect(registry.get(seen!.id)?.meta?.agentManifestPath).toBe(agentPath)
    expect(spawningCallerContext(seen!.id)).toBeUndefined()
  })

  it("is cleared when the driver fails to start", async () => {
    let id = ""
    const { agentStart } = await setup(async args => {
      id = mintedIdOf(args)
      throw new Error("boom")
    })
    expect((await agentStart(await writeAgent())).isError).toBe(true)
    expect(id).not.toBe("")
    expect(spawningCallerContext(id)).toBeUndefined()
  })
})
