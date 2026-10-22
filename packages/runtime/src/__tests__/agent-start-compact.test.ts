/**
 * `agent_start`'s response projection — the COMPACT descriptor by default,
 * `full:true` for the raw one, `fields:[...]` for an explicit allowlist.
 *
 * The heavy fields (the harness' whole slash-command list, the AGENTS.md
 * body, the live mode/config registries, the full MCP specs) are what made
 * a spawn answer weigh ~29 KB; they must not travel by default any more.
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

/** The heavy fields a realistic session carries. */
const COMMANDS = Array.from({ length: 60 }, (_, i) => ({
  name: `/skill-${i}`,
  description: `Skill ${i} description lorem ipsum dolor sit amet consectetur`,
  input: { hint: `/skill-${i} [args]` },
  _meta: { scope: "user" },
}))
const MODES = [
  { id: "plan", name: "Plan" },
  { id: "build", name: "Build" },
]
const CONFIG_OPTIONS = [{ id: "model", name: "model", type: "select" }]
const MCP_SERVERS = [{ name: "daemon", transport: "http" as const, ref: "http://127.0.0.1:18790/mcp" }]
const SYSTEM_PROMPT = "AGENTS.md body — ".repeat(500)

function parseToolJson(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function setup(): Promise<{
  client: Client
  /** The LIVE descriptor of the last spawn (the object the tool serialized). */
  lastDescriptor: () => SessionDescriptor | undefined
}> {
  const registry = createSessionsRegistry({ persist: false })
  let descriptor: SessionDescriptor | undefined
  const spawnAgent = registry.spawnAgent.bind(registry)
  vi.spyOn(registry, "spawnAgent").mockImplementation((input: Parameters<typeof spawnAgent>[0]) => {
    const desc = spawnAgent(input)
    // A realistic session: the harness advertised its commands, modes and
    // config options, a daemon mount is present, and the spawn carried an
    // AGENTS.md body.
    desc.availableCommands = COMMANDS
    desc.availableModes = MODES as never
    desc.configOptions = CONFIG_OPTIONS as never
    desc.mcpServers = MCP_SERVERS
    desc.appendSystemPrompt = SYSTEM_PROMPT
    descriptor = desc
    return desc
  })

  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: (async () => ({
      sessionId: "adapter_compact_test",
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    })) as never,
    commandPreview: "mock-adapter",
  })

  const server = new McpServer({ name: "agent-start-compact-server", version: "0.0.0" })
  registerAgentTools(server, { registry, resolveAgentAdapter })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "agent-start-compact-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, lastDescriptor: () => descriptor }
}

describe("agent_start — compact descriptor by default", () => {
  it("drops the heavy fields and keeps the counters", async () => {
    const { client } = await setup()
    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", model: "gpt-5" },
      }),
    )

    // The bulky fields are GONE.
    expect(body.availableCommands).toBeUndefined()
    expect(body.availableModes).toBeUndefined()
    expect(body.configOptions).toBeUndefined()
    expect(body.mcpServers).toBeUndefined()
    expect(body.appendSystemPrompt).toBeUndefined()

    // The identity/routing fields are still there.
    expect(body.id).toMatch(/^sess_/)
    expect(body.status).toBe("running")
    expect(body.adapterSlug).toBe("claude-code")
    expect(body.model).toBe("gpt-5")
    expect(body.kind).toBe("agent-cli")

    // …replaced by counters.
    expect(body.availableCommandsCount).toBe(60)
    expect(body.availableModesCount).toBe(2)
    expect(body.configOptionsCount).toBe(1)
    expect(body.mcpServerCount).toBe(1)
    expect(body.skillsCount).toBe(0)
  })

  it("points at the session_commands tool for the command list", async () => {
    const { client } = await setup()
    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp" },
      }),
    )
    expect(body.commandsRef).toEqual({ tool: "session_commands", sessionId: body.id })
  })
})

describe("agent_start — full:true restores the raw descriptor", () => {
  it("returns the current form, field by field", async () => {
    const { client, lastDescriptor } = await setup()
    const raw = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", model: "gpt-5", full: true },
      }),
    )
    const descriptor = lastDescriptor()
    expect(descriptor).toBeDefined()
    // Exactly the pre-projection form: the raw descriptor, field by field.
    expect(raw).toEqual({ ...(descriptor as SessionDescriptor) })
    // …including every heavy field, with its exact value.
    expect(raw.availableCommands).toEqual(COMMANDS)
    expect(raw.availableModes).toEqual(MODES)
    expect(raw.configOptions).toEqual(CONFIG_OPTIONS)
    expect(raw.mcpServers).toEqual(MCP_SERVERS)
    expect(raw.appendSystemPrompt).toBe(SYSTEM_PROMPT)
    // …and none of the compact-only counters.
    expect(raw.availableCommandsCount).toBeUndefined()
    expect(raw.commandsRef).toBeUndefined()
  })
})

describe("agent_start — fields allowlist", () => {
  it("keeps only the named fields (plus id)", async () => {
    const { client } = await setup()
    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", model: "gpt-5", fields: ["id", "model"] },
      }),
    )
    expect(Object.keys(body).sort()).toEqual(["id", "model"])
    expect(body.id).toMatch(/^sess_/)
    expect(body.model).toBe("gpt-5")
  })

  it("can ask for a heavy field on purpose", async () => {
    const { client } = await setup()
    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: {
          adapter: "claude-code",
          cwd: "/tmp",
          fields: ["id", "availableCommandsCount", "availableCommands"],
        },
      }),
    )
    expect(Object.keys(body).sort()).toEqual(["availableCommands", "availableCommandsCount", "id"])
    expect((body.availableCommands as unknown[]).length).toBe(60)
    expect(body.availableCommandsCount).toBe(60)
  })
})
