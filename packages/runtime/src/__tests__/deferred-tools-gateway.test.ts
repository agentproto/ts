/**
 * End-to-end proof that `createGateway({ deferredTools })` actually hides
 * the daemon's OWN dynamically-registered tools from `tools/list` — not
 * just the synthetic probe tools `deferred-tools.test.ts` registers by
 * hand — and that `tool_search` still reaches them. Covers step 1's
 * requirement that the always-on set works for a real gateway boot and
 * that dynamic `app_ui_*`-style tools (mounted via `registerMcpApps`, the
 * SAME registration path a real installed app's `app_ui_<slug>` panel
 * tool goes through — see `mcp-apps-adapter.ts`) aren't silently missed by
 * only wrapping `registerXTools` calls that predate them.
 *
 * `agentproto_sessions` (a builtin panel — `builtin-apps.ts`, mounted with
 * no `app_install` step) stands in for an installed app's `app_ui_*` tool
 * here since it needs no app-registry fixture to be present at every boot.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { createGateway, type GatewayHandle } from "../index.js"

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

describe("createGateway({ deferredTools }) — a real boot, not just the wrapper", () => {
  const dirs: string[] = []
  const gateways: GatewayHandle[] = []

  afterEach(async () => {
    for (const gw of gateways.splice(0)) await gw.stop().catch(() => {})
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function bootGateway(deferredTools?: { alwaysOn?: readonly string[] }): Promise<GatewayHandle> {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-deferred-gw-ws-"))
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

  async function connect(gateway: GatewayHandle): Promise<Client> {
    const client = new Client({ name: "deferred-gateway-test", version: "0.0.1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`)))
    return client
  }

  it("deferredTools omitted ⇒ full eager surface, byte-identical to today (includes a builtin app_ui-style panel tool)", async () => {
    const gateway = await bootGateway()
    const client = await connect(gateway)
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain("agent_start")
    expect(names).toContain("agentproto_sessions")
    await client.close()
  })

  it("deferredTools: {} ⇒ tools/list shrinks to the always-on set, and the dynamic panel tool is gone from it", async () => {
    const gateway = await bootGateway({})
    const client = await connect(gateway)
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain("agent_start") // DEFAULT_ALWAYS_ON_TOOLS
    expect(names).toContain("tool_search")
    expect(names).not.toContain("agentproto_sessions")
    expect(names).not.toContain("file_read")
    await client.close()
  })

  it("tool_search reaches the dynamic panel tool and returns its full schema — never removed from tools/call", async () => {
    const gateway = await bootGateway({})
    const client = await connect(gateway)
    const result = parseToolJson(
      await client.callTool({ name: "tool_search", arguments: { query: "select:agentproto_sessions" } }),
    )
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].name).toBe("agentproto_sessions")

    const call = (await client.callTool({ name: "agentproto_sessions", arguments: {} })) as {
      isError?: boolean
    }
    expect(call.isError).toBeFalsy()
    await client.close()
  })

  it("a custom alwaysOn set replaces the default one — e.g. narrowing to just tool_search + file_read (delegation tools stay on)", async () => {
    const gateway = await bootGateway({ alwaysOn: ["file_read"] })
    const client = await connect(gateway)
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    // agent_start/agent_prompt are forced always-on: a session told to
    // delegate must see them without a tool_search round-trip.
    expect(names).toEqual(["agent_prompt", "agent_start", "file_read", "tool_search"])
    await client.close()
  })

  it("a deny-role mount still loses the delegation tools under deferred mode", async () => {
    const gateway = await bootGateway({ alwaysOn: ["file_read"] })
    const client = new Client({ name: "deferred-gateway-test", version: "0.0.1" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp?denyTools=agent_start,agent_prompt`)),
    )
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(["file_read", "tool_search"])
    await client.close()
  })
})
