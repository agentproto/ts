/**
 * MCP-transport coverage for `auth_profile_list` — its limit/cursor
 * pagination (PR-8) and its compact-by-default projection +
 * `full:true`/`fields` escape hatches (tool-transformer migration). Mirrors
 * llm-endpoint-link-tools.test.ts's temp-HOME isolation + addAuthProfile
 * seeding. Profiles are seeded WITHOUT a credentialRef, so
 * `describeProfileKey` never touches the OS keychain (each row reports
 * `self-refreshing`); what's under test is the page envelope and the
 * projection, not key identity.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { addAuthProfile } from "@agentproto/auth"

import { registerAuthProfileTools } from "../auth-profile-tools.js"

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-auth-profile-tools-"))
  process.env.HOME = home
  await addAuthProfile({ id: "p-1", endpoint: "openrouter", method: "api-key" })
  await addAuthProfile({ id: "p-2", endpoint: "openrouter", method: "api-key" })
  await addAuthProfile({ id: "p-3", endpoint: "anthropic", method: "oauth-bearer" })
  // One profile carrying the bulky field the compact projection drops, so
  // compact-vs-full is observable.
  await addAuthProfile({
    id: "p-4",
    endpoint: "moonshot",
    method: "api-key",
    costBudget: { maxCostUsd: 5, window: "5h", scope: "profile" },
  })
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("auth_profile_list pagination (PR-8)", () => {
  it("page-walk with limit=2 covers exactly the unpaginated list; default call unchanged", async () => {
    const server = new McpServer({ name: "auth-profile-tools-test-server", version: "0.0.0" })
    registerAuthProfileTools(server)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "auth-profile-tools-test-client", version: "0.0.0" })
    await client.connect(clientTransport)

    // Default call unchanged: the { profiles } envelope, no page fields.
    const unpaginated = parse(await client.callTool({ name: "auth_profile_list", arguments: {} }))
    expect(unpaginated.profiles.map((p: { id: string }) => p.id)).toEqual(["p-1", "p-2", "p-3", "p-4"])
    expect(unpaginated.items).toBeUndefined()
    expect(unpaginated.total).toBeUndefined()

    // Page-walk: the union of pages equals the unpaginated list exactly.
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = parse(
        await client.callTool({
          name: "auth_profile_list",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      )
      expect(page.total).toBe(4)
      union.push(...page.items.map((p: { id: string }) => p.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(["p-1", "p-2", "p-3", "p-4"])

    await client.close()
  })

  it("pagination applies AFTER the endpoint filter", async () => {
    const server = new McpServer({ name: "auth-profile-tools-test-server-2", version: "0.0.0" })
    registerAuthProfileTools(server)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "auth-profile-tools-test-client-2", version: "0.0.0" })
    await client.connect(clientTransport)

    const page = parse(
      await client.callTool({
        name: "auth_profile_list",
        arguments: { endpoint: "anthropic", limit: 10 },
      }),
    )
    // total reflects the filtered set (1), not the whole store (4).
    expect(page.total).toBe(1)
    expect(page.items.map((p: { id: string }) => p.id)).toEqual(["p-3"])

    await client.close()
  })
})

describe("auth_profile_list compact projection (tool-transformer migration)", () => {
  async function setup() {
    const server = new McpServer({ name: "auth-profile-tools-compact-server", version: "0.0.0" })
    registerAuthProfileTools(server)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "auth-profile-tools-compact-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return { client, close: () => client.close() }
  }

  it("default output is compact: costBudget is dropped, identity + keyStatus kept", async () => {
    const { client, close } = await setup()
    const out = parse(await client.callTool({ name: "auth_profile_list", arguments: {} }))
    const rows = out.profiles as Array<Record<string, unknown>>
    const p4 = rows.find(r => r.id === "p-4")!
    // The bulky field the compact projection drops.
    expect(p4.costBudget).toBeUndefined()
    // The identity fields a listing caller needs survive compaction.
    expect(p4).toMatchObject({ id: "p-4", endpoint: "moonshot", method: "api-key", keyStatus: "self-refreshing" })
    await close()
  })

  it("full:true returns the old verbose shape (costBudget restored)", async () => {
    const { client, close } = await setup()
    const out = parse(
      await client.callTool({ name: "auth_profile_list", arguments: { full: true } }),
    )
    const p4 = (out.profiles as Array<Record<string, unknown>>).find(r => r.id === "p-4")!
    expect(p4.costBudget).toEqual({ maxCostUsd: 5, window: "5h", scope: "profile" })
    await close()
  })

  it("compact:false behaves like full:true", async () => {
    const { client, close } = await setup()
    const out = parse(
      await client.callTool({ name: "auth_profile_list", arguments: { compact: false } }),
    )
    const p4 = (out.profiles as Array<Record<string, unknown>>).find(r => r.id === "p-4")!
    expect(p4.costBudget).toEqual({ maxCostUsd: 5, window: "5h", scope: "profile" })
    await close()
  })

  it("fields is a per-item allowlist (paginated envelope branch)", async () => {
    const { client, close } = await setup()
    const page = parse(
      await client.callTool({
        name: "auth_profile_list",
        arguments: { limit: 10, fields: ["id", "endpoint"] },
      }),
    )
    expect(page.total).toBe(4)
    for (const row of page.items as Array<Record<string, unknown>>) {
      expect(Object.keys(row).sort()).toEqual(["endpoint", "id"])
    }
    await close()
  })

  it("paginated rows are compact by default; full:true restores them on the envelope too", async () => {
    const { client, close } = await setup()
    const page = parse(
      await client.callTool({ name: "auth_profile_list", arguments: { limit: 10 } }),
    )
    const p4 = (page.items as Array<Record<string, unknown>>).find(r => r.id === "p-4")!
    expect(p4.costBudget).toBeUndefined()
    expect(page.total).toBe(4)

    const fullPage = parse(
      await client.callTool({ name: "auth_profile_list", arguments: { limit: 10, full: true } }),
    )
    const fullP4 = (fullPage.items as Array<Record<string, unknown>>).find(r => r.id === "p-4")!
    expect(fullP4.costBudget).toEqual({ maxCostUsd: 5, window: "5h", scope: "profile" })
    await close()
  })
})
