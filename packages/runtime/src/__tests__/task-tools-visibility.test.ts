/**
 * Which of the four task-board tools (`task_create` / `task_list` /
 * `task_claim` / `task_update`) a session's `tools/list` actually shows, for
 * every mount shape the daemon hands out — driven through a REAL
 * `createGateway` `/mcp` endpoint, not the wrapper in isolation.
 *
 * Pins down a field report: a long-lived claude-code supervisor could call
 * `task_list` but never saw the three write tools. The four are registered
 * the same way through the same (possibly wrapped) server, so every default
 * mount shows all four or none. Only two daemon-side knobs can split them:
 *
 *  - a custom `defaults.mcp.deferredTools.alwaysOn` that names `task_list`
 *    but not its siblings (a custom set REPLACES `DEFAULT_ALWAYS_ON_TOOLS`):
 *    the three are then deferred — hidden from `tools/list`, still callable,
 *    reachable through `tool_search`;
 *  - an `allowTools` scope (an AIP-42 agent's AGENT.md `tools:`, persisted on
 *    the session descriptor so it survives restarts) that names `task_list`
 *    but not its siblings: the three are then never registered at all.
 *
 * Both are configuration on the operator's side, not a registration gap.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { createGateway, DEFAULT_ALWAYS_ON_TOOLS, type GatewayHandle } from "../index.js"
import {
  DEFAULT_ORCHESTRATOR_TOOLS,
  createOrchestratorMcpServerFactory,
  createScopeTokenRegistry,
} from "../orchestrator-gateway.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"

const TASK_TOOLS = ["task_claim", "task_create", "task_list", "task_update"]
const TASK_WRITE_TOOLS = ["task_claim", "task_create", "task_update"]

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

const taskToolsIn = (names: readonly string[]): string[] =>
  names.filter(n => TASK_TOOLS.includes(n)).sort()

describe("task_* tools/list visibility — every mount shape", () => {
  const dirs: string[] = []
  const gateways: GatewayHandle[] = []

  afterEach(async () => {
    for (const gw of gateways.splice(0)) await gw.stop().catch(() => {})
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function bootGateway(deferredTools?: { alwaysOn?: readonly string[] }): Promise<GatewayHandle> {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-task-vis-ws-"))
    dirs.push(workspace)
    const gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      ...(deferredTools ? { deferredTools } : {}),
    })
    gateways.push(gateway)
    return gateway
  }

  async function connect(gateway: GatewayHandle, query = ""): Promise<Client> {
    const client = new Client({ name: "task-visibility-test", version: "0.0.1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp${query}`)))
    return client
  }

  async function listedNames(gateway: GatewayHandle, query = ""): Promise<string[]> {
    const client = await connect(gateway, query)
    const { tools } = await client.listTools()
    await client.close()
    return tools.map(t => t.name)
  }

  it("the default always-on set carries all four (deferred mode keeps them together)", () => {
    for (const name of TASK_TOOLS) expect(DEFAULT_ALWAYS_ON_TOOLS).toContain(name)
    for (const name of TASK_TOOLS) expect(DEFAULT_ORCHESTRATOR_TOOLS).toContain(name)
  })

  it.each([
    // claude-code supervisor: `nativeToolSearch` ⇒ the self-mount is eager.
    ["eager daemon, supervisor self-mount (?deferred=0)", "?deferred=0"],
    // Bare `/mcp` on an eager daemon (no role / no override).
    ["eager daemon, bare /mcp", ""],
    // executor role default: deferredTools on + delegation denied.
    ["eager daemon, executor self-mount (?deferred=1&denyTools=…)", "?deferred=1&denyTools=agent_start,agent_prompt"],
    // A daemon-spawned session identifies itself (app-state write gate).
    ["eager daemon, ?callerSessionId=", "?deferred=0&callerSessionId=brain"],
  ])("%s ⇒ all four task tools listed", async (_label, query) => {
    const gateway = await bootGateway()
    expect(taskToolsIn(await listedNames(gateway, query))).toEqual(TASK_TOOLS)
  })

  it("daemon booted deferred with the DEFAULT always-on set ⇒ all four listed", async () => {
    const gateway = await bootGateway({})
    const names = await listedNames(gateway)
    expect(names).toContain("tool_search")
    expect(taskToolsIn(names)).toEqual(TASK_TOOLS)
  })

  it("orchestrator scoped sub-gateway (default scope) ⇒ all four listed", async () => {
    const sessionEvents = createSessionEventBus()
    const eventRing = createEventRing()
    eventRing.wire(sessionEvents)
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      registry,
      sessionEvents,
      eventRing,
    })
    const server = await factory(createScopeTokenRegistry().mint())
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "task-visibility-test", version: "0.0.1" })
    await client.connect(clientTransport)
    const { tools } = await client.listTools()
    await client.close()
    expect(taskToolsIn(tools.map(t => t.name))).toEqual(TASK_TOOLS)
  })

  // ── The two configurations that DO split read from write ─────────────

  it("custom alwaysOn naming only task_list ⇒ the write tools are deferred, NOT gone: tool_search finds them, tools/call works", async () => {
    const gateway = await bootGateway({ alwaysOn: ["task_list"] })
    const client = await connect(gateway)
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(taskToolsIn(names)).toEqual(["task_list"])
    expect(names).toContain("tool_search")

    // task_list's own description points at the recovery path.
    const listDesc = tools.find(t => t.name === "task_list")?.description ?? ""
    expect(listDesc).toContain("tool_search")
    expect(listDesc).toContain("select:task_create,task_claim,task_update")

    const found = parseToolJson(
      await client.callTool({
        name: "tool_search",
        arguments: { query: "select:task_create,task_claim,task_update" },
      }),
    )
    expect(found.tools.map((t: { name: string }) => t.name).sort()).toEqual(TASK_WRITE_TOOLS)

    // A plain keyword search reaches them too.
    const byKeyword = parseToolJson(
      await client.callTool({ name: "tool_search", arguments: { query: "task", maxResults: 10 } }),
    )
    for (const name of TASK_WRITE_TOOLS) {
      expect(byKeyword.tools.map((t: { name: string }) => t.name)).toContain(name)
    }

    // Callable without any tools/list refresh (no ledger wired here ⇒ the
    // structured "not available" reply, which proves the call was routed).
    const call = parseToolJson(
      await client.callTool({ name: "task_create", arguments: { title: "probe" } }),
    )
    expect(call).toBeDefined()
    await client.close()
  })

  it("allowTools naming only task_list (a stale AGENT.md `tools:`) ⇒ the write tools are not registered at all", async () => {
    const gateway = await bootGateway()
    const client = await connect(gateway, "?allowTools=task_list&deferred=0")
    const { tools } = await client.listTools()
    expect(taskToolsIn(tools.map(t => t.name))).toEqual(["task_list"])
    const call = (await client.callTool({ name: "task_create", arguments: { title: "probe" } })) as {
      isError?: boolean
    }
    expect(call.isError).toBe(true)
    await client.close()
  })
})
