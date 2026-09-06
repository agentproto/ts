/**
 * agent_start's `presetId` resolution — the zero-input harness-preset path.
 *
 * A saved user preset can supply the adapter (via `adapter` OR its canonical
 * `harness` alias) plus the decomposed session axes, so a spawn names only a
 * `presetId`. This exercises the resolution ladder in agent-tools.ts:
 *   adapter = input.adapter ?? input.harness ?? preset.adapter ?? preset.harness
 * over a real MCP transport, plus the two failure branches (unknown preset,
 * and a preset that provides no adapter with none supplied explicitly).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { saveUserPreset } from "../user-presets.js"
import type { AgentAdapterResolver } from "../http-server.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function setup(startSession: ReturnType<typeof vi.fn>) {
  const registry = createSessionsRegistry({ persist: false })
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession,
    commandPreview: "mock-adapter",
  })

  const server = new McpServer({ name: "agent-start-preset-server", version: "0.0.0" })
  registerAgentTools(server, { registry, resolveAgentAdapter })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "agent-start-preset-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client }
}

function fakeStartSession() {
  return vi.fn(async () => ({
    sessionId: "adapter_preset_test",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }))
}

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-agent-start-preset-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe("agent_start — presetId resolution", () => {
  it("resolves the adapter from a preset's `harness` alias and applies its decomposed axes", async () => {
    await saveUserPreset({
      id: "fast-hermes",
      label: "Fast Hermes",
      harness: "hermes",
      effort: "high",
      posture: "bypass",
      contextProfile: "lean",
    })
    const startSession = fakeStartSession()
    const { client } = await setup(startSession)

    // Zero explicit adapter/harness — the preset alone names the harness.
    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { presetId: "fast-hermes", cwd: "/tmp" },
      }),
    )
    expect(body.id).toMatch(/^sess_/)
    expect(body).toMatchObject({
      adapterSlug: "hermes",
      harness: "hermes",
      effort: "high",
      posture: "bypass",
      contextProfile: "lean",
    })
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it("resolves the adapter from a preset's `adapter` field too", async () => {
    await saveUserPreset({ id: "by-adapter", label: "By adapter", adapter: "claude-code" })
    const startSession = fakeStartSession()
    const { client } = await setup(startSession)

    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { presetId: "by-adapter", cwd: "/tmp" },
      }),
    )
    expect(body.adapterSlug).toBe("claude-code")
  })

  it("an explicit adapter on the call outranks the preset's harness", async () => {
    await saveUserPreset({ id: "fast-hermes", label: "Fast Hermes", harness: "hermes" })
    const startSession = fakeStartSession()
    const { client } = await setup(startSession)

    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { presetId: "fast-hermes", adapter: "claude-code", cwd: "/tmp" },
      }),
    )
    expect(body.adapterSlug).toBe("claude-code")
  })

  it("rejects an unknown presetId before touching the adapter", async () => {
    const startSession = fakeStartSession()
    const { client } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { presetId: "does-not-exist", cwd: "/tmp" },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    expect(res.isError).toBe(true)
    expect(res.content?.[0]?.text).toContain('no user preset "does-not-exist"')
    expect(startSession).not.toHaveBeenCalled()
  })

  it("errors when neither the call nor the resolved preset supplies an adapter", async () => {
    await saveUserPreset({ id: "axes-only", label: "Axes only", effort: "low" })
    const startSession = fakeStartSession()
    const { client } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { presetId: "axes-only", cwd: "/tmp" },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    expect(res.isError).toBe(true)
    expect(res.content?.[0]?.text).toContain("adapter is required")
    expect(startSession).not.toHaveBeenCalled()
  })
})
