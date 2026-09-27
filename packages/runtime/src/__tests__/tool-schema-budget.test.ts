/**
 * Budget guard for the daemon's MCP tool schemas (the "slim descriptions"
 * chantier — see `.plans/agentproto-onboarding/SLIM-MCP-TOOL-DESCRIPTIONS.md`
 * in the studio repo). Two independent regressions this catches:
 *
 *  1. The deferred always-on set's TOTAL `tools/list` bytes creeping back up
 *     — every session pays this on its very first request, deferred or not.
 *  2. Any SINGLE description (a tool's own, or one of its schema properties',
 *     at any nesting depth) growing back into a multi-paragraph manual
 *     instead of staying a one-line contract with a `tool_help` pointer.
 *
 * Budgets are set just above the measured result at the time this test was
 * written (see `scripts/measure-mcp-tools.mjs`) — enough headroom for normal
 * field additions, tight enough to fail loudly if a new tool ships with an
 * `agent_start`-sized wall of text.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { createGateway, type GatewayHandle } from "../index.js"
import { measureToolList } from "../tool-schema-measure.js"

/** Always-on set: ~51.4 KB measured after slimming agent_start (down from
 *  ~63.6 KB baseline). Headroom for normal growth without re-opening this
 *  file on every field addition. */
const ALWAYS_ON_BUDGET_BYTES = 60_000

/** No single description — a tool's own, or any schema property's, at any
 *  nesting depth — may exceed this. The plan's own cap. */
const MAX_DESCRIPTION_CHARS = 2_500

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

/** Every `description` string found by walking a JSON-Schema-shaped object
 *  (tool inputSchema), tagged with a dotted path for a readable failure. */
function collectDescriptions(
  obj: unknown,
  path: string,
  out: Array<{ path: string; description: string }>,
): void {
  if (!obj || typeof obj !== "object") return
  const record = obj as Record<string, unknown>
  if (typeof record.description === "string") {
    out.push({ path, description: record.description })
  }
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === "object") collectDescriptions(value, `${path}.${key}`, out)
  }
}

describe("MCP tool schema budget", () => {
  const dirs: string[] = []
  const gateways: GatewayHandle[] = []

  afterEach(async () => {
    for (const gw of gateways.splice(0)) await gw.stop().catch(() => {})
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function bootGateway(deferredTools?: { alwaysOn?: readonly string[] }): Promise<GatewayHandle> {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-tool-budget-ws-"))
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

  async function listTools(gateway: GatewayHandle) {
    const client = new Client({ name: "tool-schema-budget-test", version: "0.0.1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`)))
    const { tools } = await client.listTools()
    await client.close()
    return tools
  }

  it("deferred always-on set stays under the byte budget", async () => {
    const gateway = await bootGateway({})
    const tools = await listTools(gateway)
    const { totalBytes, entries } = measureToolList(tools)
    expect(
      totalBytes,
      `always-on tools/list grew to ${totalBytes} bytes (budget ${ALWAYS_ON_BUDGET_BYTES}). ` +
        `Biggest: ${entries.slice(0, 5).map(e => `${e.name}=${e.bytes}`).join(", ")}`,
    ).toBeLessThanOrEqual(ALWAYS_ON_BUDGET_BYTES)
  })

  it("no tool or field description on the full surface exceeds the per-description cap", async () => {
    const gateway = await bootGateway()
    const tools = await listTools(gateway)

    const offenders: string[] = []
    for (const tool of tools) {
      if (tool.description && tool.description.length > MAX_DESCRIPTION_CHARS) {
        offenders.push(`${tool.name} (tool description): ${tool.description.length} chars`)
      }
      const found: Array<{ path: string; description: string }> = []
      collectDescriptions(tool.inputSchema, "inputSchema", found)
      for (const { path, description } of found) {
        if (description.length > MAX_DESCRIPTION_CHARS) {
          offenders.push(`${tool.name} ${path}: ${description.length} chars`)
        }
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([])
  })
})
