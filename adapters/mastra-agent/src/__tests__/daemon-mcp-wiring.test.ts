/**
 * P7 deliverable 1 — proves `makeAgentFactory`'s `resolveTool` actually wires
 * the generic daemon MCP proxy end to end: an AGENT.md declaring
 * `app_data_read` (a daemon tool with no curated executor in daemon-tools.ts
 * and no workspace-tools.ts executor either) gets a REAL, callable proxy in
 * `config.tools`, backed by a fake daemon (`McpServer` + `InMemoryTransport`,
 * no real network) — and the allowlist holds: `mcp_imported_call`, exposed
 * by that same fake daemon but never declared in this AGENT.md's `tools:`,
 * never becomes callable.
 *
 * Same "subclass AgentController to capture its config" technique as
 * `daemon-tools-wiring.test.ts` (WP-5) — real `.init()`/`.createSession()`
 * still work, we just never need them since the config object alone answers
 * "is it wired, and does it actually work".
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AgentControllerConfig } from "@mastra/core/agent-controller"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeAgentFactory } from "../default-agent.js"

const capturedConfigs: Array<AgentControllerConfig<unknown>> = []

vi.mock("@mastra/core/agent-controller", async importOriginal => {
  const actual = await importOriginal<typeof import("@mastra/core/agent-controller")>()
  class SpyingAgentController<TState> extends actual.AgentController<TState> {
    constructor(config: AgentControllerConfig<TState>) {
      capturedConfigs.push(config as AgentControllerConfig<unknown>)
      super(config)
    }
  }
  return { ...actual, AgentController: SpyingAgentController }
})

const tmpDirs: string[] = []
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastra-agent-p7-mcp-wiring-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  capturedConfigs.length = 0
})

/** A fixture app agent (mirrors `@agentik/seo-auditor`'s shape from the P7
 *  brief) declaring ONE daemon tool (`app_data_read`) that neither
 *  workspace-tools.ts nor daemon-tools.ts's curated set can wire. */
async function writeSeoAuditorAgentMd(cwd: string): Promise<string> {
  const path = join(cwd, "AGENT.md")
  await writeFile(
    path,
    [
      "---",
      "schema: agent/v1",
      "id: seo-auditor",
      "description: Reads site data and reports on it.",
      "model: mock/p7-mcp-wiring",
      "tools:",
      "  - app_data_read",
      "---",
      "",
      "Read .agentproto/data/sites.json via app_data_read and say how many sites there are.",
      "",
    ].join("\n"),
    "utf8",
  )
  return path
}

/** Fake daemon exposing `app_data_read` (seeded with the P7 brief's own
 *  fixture: 2 sites, Demo Shop + Freelance Blog) AND `mcp_imported_call` —
 *  the second tool exists purely to prove the allowlist: this AGENT.md never
 *  declares it, so it must never show up as callable. */
async function buildFakeDaemon() {
  const server = new McpServer({ name: "fake-daemon", version: "0.0.0" })
  server.tool(
    "app_data_read",
    "Read an app data file.",
    { appId: z.string(), path: z.string() },
    async input => ({
      content: [{ type: "text" as const, text: "unused" }],
      structuredContent: {
        appId: input.appId,
        path: input.path,
        exists: true,
        content: { sites: [{ name: "Demo Shop" }, { name: "Freelance Blog" }] },
      },
    }),
  )
  server.tool("mcp_imported_call", "Call an imported MCP server.", { alias: z.string(), tool: z.string() }, async () => ({
    content: [{ type: "text" as const, text: "should never be reachable from this AGENT.md" }],
  }))

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
  await client.connect(clientTransport)
  return client
}

describe("makeAgentFactory — generic daemon MCP proxy (P7 deliverable 1)", () => {
  it("wires app_data_read to a real, callable proxy and reads the seeded fixture", async () => {
    const cwd = await makeTmpDir()
    const agentFile = await writeSeoAuditorAgentMd(cwd)
    const client = await buildFakeDaemon()

    const factory = makeAgentFactory({
      agentFile,
      cwd,
      appId: "@agentik/seo-auditor",
      daemonMcp: { client },
    })
    await factory()

    expect(capturedConfigs).toHaveLength(1)
    const tools = capturedConfigs[0]!.tools as Record<string, { execute?: (input: unknown) => Promise<unknown> }>
    expect(tools.app_data_read).toBeDefined()

    // The model never has to know its own appId — it was auto-injected — and
    // the call actually round-trips through the fake daemon.
    const result = await tools.app_data_read!.execute!({ path: ".agentproto/data/sites.json" })
    expect(result).toEqual({
      appId: "@agentik/seo-auditor",
      path: ".agentproto/data/sites.json",
      exists: true,
      content: { sites: [{ name: "Demo Shop" }, { name: "Freelance Blog" }] },
    })
  })

  it("never wires mcp_imported_call — the fake daemon has it, but this AGENT.md never declared it (allowlist)", async () => {
    const cwd = await makeTmpDir()
    const agentFile = await writeSeoAuditorAgentMd(cwd)
    const client = await buildFakeDaemon()

    const factory = makeAgentFactory({ agentFile, cwd, daemonMcp: { client } })
    await factory()

    const tools = capturedConfigs[0]!.tools as Record<string, unknown>
    expect(tools.mcp_imported_call).toBeUndefined()
  })
})
