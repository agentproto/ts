/**
 * E2E: daemon→MCP→verbe→disque pour create_driver et self_inspect.
 *
 * Principe : on boot un vrai McpServer (createMcpServer) puis on s'y
 * connecte via InMemoryTransport + Client SDK. Chaque appel passe par
 * le chemin complet JSON-RPC (serialize → deserialize → handler → disk).
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { toolSpec } from "@agentproto/tool"
import { driverSpec } from "@agentproto/driver"

import { createMcpServer } from "../index.js"

// MCP SDK transport + client — invoked via the real JSON-RPC path.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { TextContent } from "@modelcontextprotocol/sdk/types.js"

// ── helpers ──────────────────────────────────────────────────────────

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client(
    { name: "e2e-test", version: "0.0.1" },
    { capabilities: {} },
  )
  await client.connect(clientTransport)
  return client
}

/** Call an MCP tool and return the parsed JSON payload from content[0]. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  const item = result.content[0] as TextContent | undefined
  if (!item || item.type !== "text") {
    throw new Error(`Expected text content from tool '${name}'; got ${JSON.stringify(result.content)}`)
  }
  return JSON.parse(item.text) as Record<string, unknown>
}

// ── tests ─────────────────────────────────────────────────────────────

describe("e2e: create_driver → disque → load_driver / list_driver", () => {
  it("écrit DRIVER.md sur le disque et le retrouve via load/list", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agentproto-e2e-driver-"))
    let client: Client | undefined
    try {
      const { server, registered } = await createMcpServer({
        specs: [toolSpec, driverSpec],
        workspace,
      })

      // Vérifie que driver est bien enregistré parmi les specs.
      expect(registered).toContain("driver")

      client = await connectClient(server)

      // ── create_driver ─────────────────────────────────────────────
      const created = await callTool(client, "create_driver", {
        params: {
          id: "echo-http",
          name: "Echo HTTP Driver",
          description: "Minimal e2e test driver",
          kind: "http",
          implements: [{ tool: "echo", version: "1.0.0" }],
        },
        dir: "drivers",
      })

      // Le serveur ancre "drivers" → join(workspace, "drivers")
      // pathOf(handle) = "echo-http/DRIVER.md"
      // → path final = join(workspace, "drivers", "echo-http", "DRIVER.md")
      const expectedPath = join(workspace, "drivers", "echo-http", "DRIVER.md")
      expect(created.path).toBe(expectedPath)

      // Le fichier doit exister sur le disque.
      expect(existsSync(expectedPath)).toBe(true)

      // Contenu minimal attendu dans le fichier.
      const onDisk = await readFile(expectedPath, "utf8")
      expect(onDisk).toContain("schema: agentproto/driver/v1")
      expect(onDisk).toContain("id: echo-http")
      expect(onDisk).toContain("kind: http")

      // ── load_driver ───────────────────────────────────────────────
      const loaded = await callTool(client, "load_driver", {
        path: "drivers/echo-http/DRIVER.md",
      })
      const handle = loaded.handle as Record<string, unknown>
      expect(handle.id).toBe("echo-http")
      expect(handle.name).toBe("Echo HTTP Driver")
      expect(handle.kind).toBe("http")

      // ── list_driver ───────────────────────────────────────────────
      const listed = await callTool(client, "list_driver", {
        dir: "drivers",
      })
      expect(listed.count).toBe(1)
      const handles = listed.handles as unknown[]
      expect(handles).toHaveLength(1)
      expect((handles[0] as Record<string, unknown>).id).toBe("echo-http")
    } finally {
      await client?.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe("e2e: self_inspect", () => {
  it("résout les file-refs d'un AGENT.md et retourne { agentPath, tools, routines }", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agentproto-e2e-inspect-"))
    let client: Client | undefined
    try {
      // TOOL.md référencé par l'agent.
      await mkdir(join(workspace, "tools", "echo"), { recursive: true })
      await writeFile(
        join(workspace, "tools", "echo", "TOOL.md"),
        `---
schema: agentproto/tool/v1
id: echo
name: Echo
description: Echo tool for e2e testing
version: 1.0.0
---
`,
      )

      // AGENT.md avec un file-ref vers TOOL.md.
      // Chemin résolu par selfInspect : <workspace>/.agents/<id>/AGENT.md
      await mkdir(join(workspace, ".agents", "writer"), { recursive: true })
      await writeFile(
        join(workspace, ".agents", "writer", "AGENT.md"),
        `---
schema: agent/v1
id: writer
description: Test writer agent for e2e
model: claude-sonnet-4-5
tools:
  - file: tools/echo/TOOL.md
---
`,
      )

      const { server } = await createMcpServer({
        specs: [toolSpec, driverSpec],
        workspace,
      })
      client = await connectClient(server)

      // ── self_inspect ──────────────────────────────────────────────
      const result = await callTool(client, "self_inspect", {
        agentId: "writer",
      })

      expect(result.agentPath).toBe(
        join(workspace, ".agents", "writer", "AGENT.md"),
      )

      const tools = result.tools as Array<{ id: string; description: string }>
      expect(Array.isArray(tools)).toBe(true)
      expect(tools).toHaveLength(1)
      expect(tools[0]?.id).toBe("echo")
      expect(tools[0]?.description).toBe("Echo tool for e2e testing")

      const routines = result.routines as unknown[]
      expect(routines).toEqual([])
    } finally {
      await client?.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("renvoie { error: 'agent_not_found' } quand l'AGENT.md est absent", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agentproto-e2e-inspect-"))
    let client: Client | undefined
    try {
      const { server } = await createMcpServer({
        specs: [toolSpec, driverSpec],
        workspace,
      })
      client = await connectClient(server)

      const result = await callTool(client, "self_inspect", {
        agentId: "ghost",
      })

      // Le tool ne lance pas d'exception protocole — il renvoie un contenu
      // avec isError:true et { error, message } dans le texte JSON.
      expect(result.error).toBe("agent_not_found")
      expect(typeof result.message).toBe("string")
    } finally {
      await client?.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
