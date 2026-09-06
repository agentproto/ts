import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { addAuthProfile } from "@agentproto/auth"
import { registerLlmEndpointTools } from "../llm-endpoint-tools.js"
import type { LlmEndpointRegistry } from "../llm-endpoint-registry.js"
import { getLlmEndpointLink } from "../llm-endpoint-links-store.js"

interface Registered {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[]
    isError?: boolean
  }>
}

function fakeServer(): { server: McpServer; tools: Map<string, Registered["handler"]> } {
  const tools = new Map<string, Registered["handler"]>()
  const server = {
    tool: (
      name: string,
      _description: string,
      _shape: Record<string, unknown>,
      handler: Registered["handler"],
    ) => {
      tools.set(name, handler)
    },
  } as unknown as McpServer
  return { server, tools }
}

/** Minimal registry stub — only `status()` is used by the link verbs. */
function fakeRegistry(running: boolean): LlmEndpointRegistry {
  return {
    status: async () => ({ running }),
  } as unknown as LlmEndpointRegistry
}

function parse(result: { content: { type: "text"; text: string }[] }): unknown {
  return JSON.parse(result.content[0]!.text)
}

let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-link-tools-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("llm_endpoint_set_upstream_link", () => {
  it("persists a link and reports restartRequired when the proxy is running", async () => {
    const { server, tools } = fakeServer()
    registerLlmEndpointTools(server, { registry: fakeRegistry(true) })
    const set = tools.get("llm_endpoint_set_upstream_link")!
    const out = parse(await set({ provider: "anthropic", profileId: "claude-subs" }))
    expect(out).toMatchObject({
      ok: true,
      provider: "anthropic",
      profileId: "claude-subs",
      applied: false,
      restartRequired: true,
    })
    await expect(getLlmEndpointLink("anthropic")).resolves.toBe("claude-subs")
  })

  it("reports restartRequired:false when the proxy is stopped (applies on next start)", async () => {
    const { server, tools } = fakeServer()
    registerLlmEndpointTools(server, { registry: fakeRegistry(false) })
    const set = tools.get("llm_endpoint_set_upstream_link")!
    const out = parse(await set({ provider: "openrouter", profileId: "or" })) as {
      restartRequired: boolean
    }
    expect(out.restartRequired).toBe(false)
    await expect(getLlmEndpointLink("openrouter")).resolves.toBe("or")
  })

  it("clears a link when profileId is null", async () => {
    const { server, tools } = fakeServer()
    registerLlmEndpointTools(server, { registry: fakeRegistry(false) })
    const set = tools.get("llm_endpoint_set_upstream_link")!
    await set({ provider: "anthropic", profileId: "x" })
    const out = parse(await set({ provider: "anthropic", profileId: null })) as {
      cleared: boolean
    }
    expect(out.cleared).toBe(true)
    await expect(getLlmEndpointLink("anthropic")).resolves.toBeUndefined()
  })

  it("rejects an unknown upstream (isError, nothing persisted)", async () => {
    const { server, tools } = fakeServer()
    registerLlmEndpointTools(server, { registry: fakeRegistry(false) })
    const set = tools.get("llm_endpoint_set_upstream_link")!
    const out = await set({ provider: "bogus", profileId: "x" })
    expect(out.isError).toBe(true)
    await expect(getLlmEndpointLink("bogus")).resolves.toBeUndefined()
  })
})

describe("llm_endpoint_list_links", () => {
  it("returns the persisted map + per-upstream eligible profiles (never a secret)", async () => {
    // Seed profiles: an eligible anthropic api-key, an eligible anthropic
    // oauth-bearer, a wrong-endpoint one, and a disabled one.
    await addAuthProfile({ id: "an-key", endpoint: "anthropic", method: "api-key" })
    await addAuthProfile({ id: "an-oauth", endpoint: "anthropic", method: "oauth-bearer" })
    await addAuthProfile({ id: "or-key", endpoint: "openrouter", method: "api-key" })
    await addAuthProfile({
      id: "an-off",
      endpoint: "anthropic",
      method: "api-key",
      disabled: true,
    })

    const { server, tools } = fakeServer()
    registerLlmEndpointTools(server, { registry: fakeRegistry(false) })
    // Persist one link so the map is non-empty.
    await tools.get("llm_endpoint_set_upstream_link")!({
      provider: "anthropic",
      profileId: "an-key",
    })

    const out = parse(await tools.get("llm_endpoint_list_links")!({})) as {
      links: Record<string, string>
      upstreams: {
        provider: string
        linkedProfile: string | null
        eligible: { id: string; method: string; endpoint: string }[]
      }[]
    }

    expect(out.links).toEqual({ anthropic: "an-key" })
    // All 8 upstreams present.
    expect(out.upstreams.map(u => u.provider)).toHaveLength(8)

    const anthropic = out.upstreams.find(u => u.provider === "anthropic")!
    expect(anthropic.linkedProfile).toBe("an-key")
    // Both api-key and oauth-bearer eligible for anthropic; disabled excluded.
    expect(anthropic.eligible.map(e => e.id).sort()).toEqual(["an-key", "an-oauth"])

    const openrouter = out.upstreams.find(u => u.provider === "openrouter")!
    expect(openrouter.eligible.map(e => e.id)).toEqual(["or-key"])

    // No secret / credentialRef leaks into the eligible shape.
    const keys = new Set(anthropic.eligible.flatMap(e => Object.keys(e)))
    expect(keys.has("credentialRef")).toBe(false)
  })

  it("page-walk with limit=3 covers exactly the unpaginated upstreams; default call unchanged (PR-8)", async () => {
    const { server, tools } = fakeServer()
    registerLlmEndpointTools(server, { registry: fakeRegistry(false) })
    const list = tools.get("llm_endpoint_list_links")!

    // Default call unchanged: the { links, upstreams } envelope, no page fields.
    const unpaginated = parse(await list({})) as {
      links: Record<string, string>
      upstreams: { provider: string }[]
      items?: unknown
      total?: number
    }
    expect(Object.keys(unpaginated.links)).toEqual([])
    const allProviders = unpaginated.upstreams.map(u => u.provider)
    expect(unpaginated.items).toBeUndefined()
    expect(unpaginated.total).toBeUndefined()

    // Page-walk: the union of pages equals the unpaginated list exactly.
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = parse(
        await list({ limit: 3, ...(cursor ? { cursor } : {}) }),
      ) as { items: { provider: string }[]; total: number; nextCursor?: string }
      expect(page.total).toBe(allProviders.length)
      union.push(...page.items.map(u => u.provider))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(allProviders)
  })
})
