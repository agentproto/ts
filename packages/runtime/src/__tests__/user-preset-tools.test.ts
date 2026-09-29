/**
 * MCP-transport coverage for `user-preset-tools.ts` — `user_preset_list` /
 * `user_preset_save` / `user_preset_delete`, the MCP twin of the
 * `/user-presets` HTTP routes (`user-presets-http-routes.test.ts`). Mirrors
 * harness-preset-tools.test.ts's real-McpServer + InMemoryTransport +
 * parseToolJson pattern, with an isolated temp-HOME-backed preset store
 * (same isolation `user-presets.test.ts` uses).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerUserPresetTools, type UserPresetToolsDeps } from "../user-preset-tools.js"
import { saveUserPreset } from "../user-presets.js"
import type { SessionDescriptor } from "../sessions.js"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

/** A minimal agent-cli row — mirrors crash-reaper.test.ts's own `row()`
 *  fixture helper. */
function row(over: Partial<SessionDescriptor> & { id: string }): SessionDescriptor {
  return {
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude (agent)",
    pid: 4242,
    status: "running",
    startedAt: "2026-07-23T00:00:00Z",
    harness: "claude-code",
    cwd: "/tmp",
    ...over,
  }
}

async function setup(registry?: UserPresetToolsDeps["registry"]) {
  const server = new McpServer({ name: "user-preset-tools-test-server", version: "0.0.0" })
  registerUserPresetTools(server, { registry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "user-preset-tools-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client }
}

let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-user-preset-tools-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("user_preset_save / user_preset_list / user_preset_delete", () => {
  it("saves, lists, and deletes a favorite — round trip", async () => {
    const { client } = await setup()

    const saved = parseToolJson(
      await client.callTool({
        name: "user_preset_save",
        arguments: { id: "fast-opus", label: "Fast Opus", adapter: "claude-code", model: "opus" },
      }),
    )
    expect(saved.preset).toMatchObject({ id: "fast-opus", label: "Fast Opus", adapter: "claude-code" })

    const listed = parseToolJson(await client.callTool({ name: "user_preset_list", arguments: {} }))
    expect(listed.presets).toHaveLength(1)
    expect(listed.presets[0]).toMatchObject({ id: "fast-opus" })
    expect(listed.recent).toBeUndefined()

    const deleted = parseToolJson(
      await client.callTool({ name: "user_preset_delete", arguments: { id: "fast-opus" } }),
    )
    expect(deleted).toEqual({ deleted: true })

    const emptyList = parseToolJson(await client.callTool({ name: "user_preset_list", arguments: {} }))
    expect(emptyList.presets).toEqual([])
  })

  it("user_preset_save upserts by id, preserving lastUsedAt across the edit", async () => {
    const { client } = await setup()
    await client.callTool({ name: "user_preset_save", arguments: { id: "fast", label: "Fast" } })
    await saveUserPreset({ id: "fast", label: "Fast", lastUsedAt: "2026-01-01T00:00:00.000Z" })

    const renamed = parseToolJson(
      await client.callTool({ name: "user_preset_save", arguments: { id: "fast", label: "Faster" } }),
    )
    expect(renamed.preset).toMatchObject({ label: "Faster", lastUsedAt: "2026-01-01T00:00:00.000Z" })
  })

  it("rejects an unsafe id before the handler runs — same `userPresetSchema` shape as saveUserPreset", async () => {
    const { client } = await setup()
    const res = await client.callTool({
      name: "user_preset_save",
      arguments: { id: "Not safe", label: "Bad" },
    })
    expect(res.isError).toBe(true)
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? ""
    expect(text).toMatch(/pattern|invalid/i)

    // Nothing was persisted.
    const listed = parseToolJson(await client.callTool({ name: "user_preset_list", arguments: {} }))
    expect(listed.presets).toEqual([])
  })

  it("user_preset_delete is idempotent — a missing id returns deleted: false", async () => {
    const { client } = await setup()
    const res = parseToolJson(
      await client.callTool({ name: "user_preset_delete", arguments: { id: "ghost" } }),
    )
    expect(res).toEqual({ deleted: false })
  })

  it("includeRecent: true threads the registry's session list through deriveRecentSpawnConfigs", async () => {
    // The derivation logic itself (dedupe, limit, field mapping) is covered
    // exhaustively in user-presets.test.ts against plain fixtures — this
    // only proves the wiring: `registry.list()` feeds the tool's `recent`.
    const registry = {
      list: () => [
        row({ id: "a", harness: "hermes", model: "deepseek", cwd: "/tmp/a" }),
      ],
    }
    const { client } = await setup(registry)
    const res = parseToolJson(
      await client.callTool({ name: "user_preset_list", arguments: { includeRecent: true } }),
    )
    expect(res.recent).toEqual([
      { adapter: "hermes", model: "deepseek", cwd: "/tmp/a", recent: true },
    ])
  })

  it("includeRecent omitted never adds a recent key; includeRecent: true with no registry wired returns an empty array, not an error", async () => {
    const { client } = await setup(undefined)

    const withoutFlag = parseToolJson(await client.callTool({ name: "user_preset_list", arguments: {} }))
    expect(withoutFlag.recent).toBeUndefined()

    const withFlag = parseToolJson(
      await client.callTool({ name: "user_preset_list", arguments: { includeRecent: true } }),
    )
    expect(withFlag.recent).toEqual([])
  })
})
