/**
 * SIZE BUDGET for `agent_start`'s answer.
 *
 * The reference session is the realistic worst case: a harness that
 * advertises 60 slash-commands AND a spawn that carried the repo's
 * AGENTS.md body. On the pre-projection code that answer weighed 29 217
 * bytes (measured, see night-deliverables/descriptor-compact/PLAN.md §2.2);
 * the compact projection must keep it under 1 500.
 *
 * The budget is the point of the projection: it is the guard that fails if
 * a bulky field creeps back into the default answer.
 */

import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

/** The repo's own AGENTS.md, the spawn's system-prompt body. */
const AGENTS_MD = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "AGENTS.md"),
  "utf8",
)

/** 60 slash-commands, a skill-heavy harness. */
const COMMANDS = Array.from({ length: 60 }, (_, i) => ({
  name: `/skill-${i}`,
  description:
    `Skill ${i} description lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor`,
  input: { hint: `/skill-${i} [args]` },
}))

/** The budget for the default (compact) answer. */
const DEFAULT_BUDGET_BYTES = 1500

/** The pre-projection answer for this reference, measured, not guessed. */
const RAW_REFERENCE_BYTES = 29_217

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return text
}

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8")

async function setup(): Promise<{ client: Client }> {
  const registry = createSessionsRegistry({ persist: false })
  const spawnAgent = registry.spawnAgent.bind(registry)
  vi.spyOn(registry, "spawnAgent").mockImplementation((input: Parameters<typeof spawnAgent>[0]) => {
    const desc = spawnAgent(input)
    desc.availableCommands = COMMANDS
    desc.appendSystemPrompt = AGENTS_MD
    return desc
  })

  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: (async () => ({
      sessionId: "adapter_budget_test",
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    })) as never,
    commandPreview: "mock-adapter",
  })

  const server = new McpServer({ name: "agent-start-budget-server", version: "0.0.0" })
  registerAgentTools(server, { registry, resolveAgentAdapter })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "agent-start-budget-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client }
}

describe("agent_start, response size budget", () => {
  it("keeps the default answer under 1500 bytes (60 commands + AGENTS.md)", async () => {
    const { client } = await setup()
    const text = textOf(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "hermes", cwd: "/tmp", model: "gpt-5" },
      }),
    )
    const size = bytesOf(text)
    expect(
      size,
      `agent_start's default answer is ${size} bytes (budget ${DEFAULT_BUDGET_BYTES})`,
    ).toBeLessThanOrEqual(DEFAULT_BUDGET_BYTES)
  })

  it("the reference IS heavy, the raw answer stays big (the escape hatch works)", async () => {
    const { client } = await setup()
    const text = textOf(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "hermes", cwd: "/tmp", model: "gpt-5", full: true },
      }),
    )
    const size = bytesOf(text)
    // The pre-projection answer measured 29 217 bytes for this reference;
    // the raw answer must still carry the heavy fields.
    expect(size).toBeGreaterThan(RAW_REFERENCE_BYTES * 0.9)
    const body = JSON.parse(text)
    expect(body.availableCommands).toHaveLength(60)
    expect(body.appendSystemPrompt).toBe(AGENTS_MD)
  })
})
