/**
 * MCP-transport coverage for `harness-preset-tools.ts`'s `harness_preset_list`
 * — specifically the `profileDisabled`/`profileMissing` enrichment added on
 * top of the store's plain `listHarnessPresets`. Mirrors app-external.test.ts's
 * real-McpServer + InMemoryTransport + parseToolJson pattern. Uses a real
 * temp-HOME-backed preset store (same isolation `harness-preset-store.test.ts`
 * uses) with a stubbed `getProfile` so no real `~/.agentproto/auth-profiles.json`
 * is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AuthProfile } from "@agentproto/auth"
import { registerHarnessPresetTools } from "../harness-preset-tools.js"
import { addHarnessPreset } from "../harness-preset-store.js"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

function profile(over: Partial<AuthProfile>): AuthProfile {
  return { id: "p", endpoint: "openrouter", method: "api-key", ...over }
}

async function setup(profiles: Record<string, AuthProfile>) {
  const server = new McpServer({ name: "harness-preset-tools-test-server", version: "0.0.0" })
  registerHarnessPresetTools(server, { getProfile: async id => profiles[id] })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "harness-preset-tools-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client }
}

let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-harness-preset-tools-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("harness_preset_list", () => {
  it("reports profileDisabled: false for an enabled profile", async () => {
    await addHarnessPreset(
      {
        id: "hm-cheap",
        harnessSlug: "hermes",
        name: "Cheap",
        profileRef: "openrouter-cheap",
        defaultModel: "z-ai/glm-5.2",
        isDefault: true,
      },
      { getProfile: async () => profile({ id: "openrouter-cheap" }) },
    )
    const { client } = await setup({ "openrouter-cheap": profile({ id: "openrouter-cheap" }) })

    const res = parseToolJson(await client.callTool({ name: "harness_preset_list", arguments: {} }))
    expect(res.presets).toHaveLength(1)
    expect(res.presets[0]).toMatchObject({ id: "hm-cheap", profileDisabled: false })
    expect(res.presets[0].profileMissing).toBeUndefined()
  })

  it("reports profileDisabled: true for a disabled profile", async () => {
    await addHarnessPreset(
      {
        id: "hm-cheap",
        harnessSlug: "hermes",
        name: "Cheap",
        profileRef: "openrouter-cheap",
        defaultModel: "z-ai/glm-5.2",
        isDefault: true,
      },
      { getProfile: async () => profile({ id: "openrouter-cheap" }) },
    )
    const { client } = await setup({
      "openrouter-cheap": profile({ id: "openrouter-cheap", disabled: true }),
    })

    const res = parseToolJson(await client.callTool({ name: "harness_preset_list", arguments: {} }))
    expect(res.presets[0]).toMatchObject({ id: "hm-cheap", profileDisabled: true })
    expect(res.presets[0].profileMissing).toBeUndefined()
  })

  it("reports profileDisabled + profileMissing: true when the profile no longer exists", async () => {
    await addHarnessPreset(
      {
        id: "hm-cheap",
        harnessSlug: "hermes",
        name: "Cheap",
        profileRef: "openrouter-cheap",
        defaultModel: "z-ai/glm-5.2",
        isDefault: true,
      },
      { getProfile: async () => profile({ id: "openrouter-cheap" }) },
    )
    // Simulate the profile having since been deleted — the tool's own
    // getProfile stub (separate from the one addHarnessPreset validated
    // against above) now reports nothing for this id.
    const { client } = await setup({})

    const res = parseToolJson(await client.callTool({ name: "harness_preset_list", arguments: {} }))
    expect(res.presets[0]).toMatchObject({
      id: "hm-cheap",
      profileDisabled: true,
      profileMissing: true,
    })
  })

  it("filters by harnessSlug while still enriching each entry", async () => {
    await addHarnessPreset(
      {
        id: "hm-a",
        harnessSlug: "hermes",
        name: "A",
        profileRef: "p1",
        defaultModel: "z-ai/glm-5.2",
        isDefault: true,
      },
      { getProfile: async () => profile({ id: "p1" }) },
    )
    await addHarnessPreset(
      {
        id: "cx-a",
        harnessSlug: "claude-code",
        name: "A",
        profileRef: "p2",
        defaultModel: "claude-sonnet-5",
        isDefault: true,
      },
      { getProfile: async () => profile({ id: "p2" }) },
    )
    const { client } = await setup({ p1: profile({ id: "p1" }), p2: profile({ id: "p2" }) })

    const res = parseToolJson(
      await client.callTool({ name: "harness_preset_list", arguments: { harnessSlug: "hermes" } }),
    )
    expect(res.presets).toHaveLength(1)
    expect(res.presets[0]).toMatchObject({ id: "hm-a", profileDisabled: false })
  })

  it("page-walk with limit=2 covers exactly the unpaginated list; default call unchanged (PR-8)", async () => {
    const ids = ["hm-1", "hm-2", "hm-3"]
    for (let i = 0; i < ids.length; i++) {
      await addHarnessPreset(
        {
          id: ids[i]!,
          harnessSlug: i === 2 ? "claude-code" : "hermes",
          name: `P${i}`,
          profileRef: "p1",
          defaultModel: "z-ai/glm-5.2",
          isDefault: false,
        },
        { getProfile: async () => profile({ id: "p1" }) },
      )
    }
    const { client } = await setup({ p1: profile({ id: "p1" }) })

    // Default call unchanged: the { presets } envelope, no page fields.
    const unpaginated = parseToolJson(await client.callTool({ name: "harness_preset_list", arguments: {} }))
    expect(unpaginated.presets.map((p: { id: string }) => p.id)).toEqual(ids)
    expect(unpaginated.items).toBeUndefined()
    expect(unpaginated.total).toBeUndefined()

    // Page-walk: the union of pages equals the unpaginated list exactly.
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = parseToolJson(
        await client.callTool({
          name: "harness_preset_list",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      )
      expect(page.total).toBe(3)
      union.push(...page.items.map((p: { id: string }) => p.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(ids)
  })
})
