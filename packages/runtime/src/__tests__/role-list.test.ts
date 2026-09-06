/**
 * Unit coverage for the `role_list` MCP tool (agent-tools.ts) — the
 * read-only introspection mirror of `adapter_list`, built on the SAME
 * `canSpawn`/`spawnableRolesFor` predicate the spawn gate uses (see
 * role.test.ts + session-spawn.test.ts's gate coverage), so the two
 * can never disagree.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { RoleProfile } from "../role.js"

async function harness(loadRoleRegistry?: () => Promise<Record<string, RoleProfile>>) {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, { registry, ...(loadRoleRegistry ? { loadRoleRegistry } : {}) })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

interface RoleListRow {
  name: string
  level: number
  delegation: string
  spawnable: string[]
}

function parseRoles(result: unknown): RoleListRow[] {
  const content = (result as { content: Array<{ text: string }> }).content
  return (JSON.parse(content[0]!.text) as { roles: RoleListRow[] }).roles
}

describe("role_list", () => {
  it("lists the two built-ins with no custom registry wired", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({ name: "role_list", arguments: {} })
      const roles = parseRoles(result)
      expect(roles.map(r => r.name).sort()).toEqual(["executor", "supervisor"])
    } finally {
      await h.close()
    }
  })

  it("supervisor's row includes executor (and itself, a peer) in `spawnable`", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({ name: "role_list", arguments: {} })
      const roles = parseRoles(result)
      const supervisor = roles.find(r => r.name === "supervisor")!
      expect(supervisor.level).toBe(100)
      expect(supervisor.delegation).toBe("allow")
      expect(supervisor.spawnable).toContain("executor")
      expect(supervisor.spawnable).toContain("supervisor")
    } finally {
      await h.close()
    }
  })

  it("executor's row has an empty `spawnable`", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({ name: "role_list", arguments: {} })
      const roles = parseRoles(result)
      const executor = roles.find(r => r.name === "executor")!
      expect(executor.level).toBe(0)
      expect(executor.delegation).toBe("deny")
      expect(executor.spawnable).toEqual([])
    } finally {
      await h.close()
    }
  })

  it("includes a custom role from the injected registry, with the correct spawnable set", async () => {
    const planner: RoleProfile = {
      name: "planner",
      disposition: "You plan work.",
      toolPolicy: { delegation: "allow" },
      level: 50,
    }
    const h = await harness(async () => ({ planner }))
    try {
      const result = await h.client.callTool({ name: "role_list", arguments: {} })
      const roles = parseRoles(result)
      const row = roles.find(r => r.name === "planner")!
      expect(row.level).toBe(50)
      expect(row.spawnable).toContain("executor")
      expect(row.spawnable).not.toContain("supervisor")
    } finally {
      await h.close()
    }
  })

  it("page-walk with limit=1 covers exactly the unpaginated list; default call unchanged (PR-8)", async () => {
    const h = await harness()
    try {
      // Default call unchanged: the { roles } envelope, no page fields.
      const unpaginated = parseRoles(await h.client.callTool({ name: "role_list", arguments: {} }))
      expect(unpaginated.map(r => r.name).sort()).toEqual(["executor", "supervisor"])

      // Page-walk: the union of pages equals the unpaginated list exactly.
      const union: RoleListRow[] = []
      let cursor: string | undefined
      do {
        const raw = JSON.parse(
          (
            (await h.client.callTool({
              name: "role_list",
              arguments: { limit: 1, ...(cursor ? { cursor } : {}) },
            })) as { content: Array<{ text: string }> }
          ).content[0]!.text,
        ) as { items: RoleListRow[]; total: number; nextCursor?: string }
        expect(raw.total).toBe(2)
        union.push(...raw.items)
        cursor = raw.nextCursor
      } while (cursor)
      expect(union.map(r => r.name).sort()).toEqual(["executor", "supervisor"])
    } finally {
      await h.close()
    }
  })
})
