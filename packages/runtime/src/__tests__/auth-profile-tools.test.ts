/**
 * Minimal MCP-transport coverage for `auth_profile_list`'s additive
 * limit/cursor pagination (PR-8) — mirrors llm-endpoint-link-tools.test.ts's
 * temp-HOME isolation + addAuthProfile seeding. Profiles are seeded WITHOUT a
 * credentialRef, so `describeProfileKey` never touches the OS keychain (each
 * row reports `self-refreshing`); what's under test is the page envelope, not
 * key identity.
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
    expect(unpaginated.profiles.map((p: { id: string }) => p.id)).toEqual(["p-1", "p-2", "p-3"])
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
      expect(page.total).toBe(3)
      union.push(...page.items.map((p: { id: string }) => p.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(["p-1", "p-2", "p-3"])

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
    // total reflects the filtered set (1), not the whole store (3).
    expect(page.total).toBe(1)
    expect(page.items.map((p: { id: string }) => p.id)).toEqual(["p-3"])

    await client.close()
  })
})
