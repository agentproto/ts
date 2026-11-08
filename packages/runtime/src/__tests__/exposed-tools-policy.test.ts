import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAppRegistry, type InstalledApp } from "../app-registry.js"
import {
  exposedAccessAllowed,
  exposedOptInMatches,
  planExposedTools,
  resolveExposedToolsMode,
} from "../exposed-tools-policy.js"

const tool = (id: string, access: "read" | "write" | "approve" = "read", over: Record<string, unknown> = {}) => ({
  id,
  access,
  description: `Tool ${id}.`,
  ...over,
})

async function registryWith(apps: Array<{ appId: string; prefix: string; tools: ReturnType<typeof tool>[] }>) {
  const dir = await mkdtemp(join(tmpdir(), "exposed-policy-"))
  const registry = createAppRegistry()
  for (const a of apps) {
    registry.upsertApp({
      appId: a.appId,
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      exposes: { agents: [], workflows: [], prefix: a.prefix, tools: a.tools },
    } as unknown as InstalledApp)
  }
  return { registry, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe("resolveExposedToolsMode", () => {
  it("defaults to read, and only off or all override it", async () => {
    const mode = (value: unknown) => resolveExposedToolsMode(async () => ({ defaults: { apps: { exposedTools: value } } }) as never)
    expect(await mode(undefined)).toBe("read")
    expect(await mode("off")).toBe("off")
    expect(await mode("all")).toBe("all")
    expect(await mode("bogus")).toBe("read")
    expect(
      await resolveExposedToolsMode(async () => {
        throw new Error("unreadable")
      }),
    ).toBe("read")
  })
})

describe("exposedAccessAllowed / exposedOptInMatches", () => {
  it("read mode lets only access: read through, all lets everything, off nothing", () => {
    expect(exposedAccessAllowed("read", "read")).toBe(true)
    expect(exposedAccessAllowed("read", "write")).toBe(false)
    expect(exposedAccessAllowed("read", "approve")).toBe(false)
    expect(exposedAccessAllowed("all", "approve")).toBe(true)
    expect(exposedAccessAllowed("off", "read")).toBe(false)
  })

  it("matches an opt-in by exact MCP name only", () => {
    expect(exposedOptInMatches(["jobkit_leads_upsert"], "jobkit_leads_upsert")).toBe(true)
    expect(exposedOptInMatches(["jobkit_leads_upsert"], "jobkit_list")).toBe(false)
    expect(exposedOptInMatches(undefined, "jobkit_list")).toBe(false)
  })
})

describe("planExposedTools", () => {
  it("plans each tool under its computed MCP name", async () => {
    const { registry, cleanup } = await registryWith([
      { appId: "@t/jobkit", prefix: "jobkit", tools: [tool("jobkit.list"), tool("jobkit.leads.upsert", "write")] },
    ])
    try {
      const plan = await planExposedTools(registry)
      expect(plan.tools.map(t => t.name)).toEqual(["jobkit_list", "jobkit_leads_upsert"])
      expect(plan.skipped).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it("never exposes an approval* tool, even from a hand-edited registry record", async () => {
    const { registry, cleanup } = await registryWith([
      { appId: "@t/jobkit", prefix: "jobkit", tools: [tool("approval_request"), tool("jobkit.list", "read", { mcpName: "approval_list" }), tool("jobkit.ok")] },
    ])
    try {
      const plan = await planExposedTools(registry)
      expect(plan.tools.map(t => t.name)).not.toEqual(expect.arrayContaining([expect.stringMatching(/approval/)]))
      expect(plan.skipped.length).toBeGreaterThan(0)
      expect(plan.skipped.every(s => /approval|invalid/.test(s.reason))).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it("skips, with a reason, an app whose prefix is the first segment of a daemon tool", async () => {
    const { registry, cleanup } = await registryWith([
      { appId: "@t/sneaky", prefix: "session", tools: [tool("session.list")] },
    ])
    try {
      const plan = await planExposedTools(registry)
      expect(plan.tools).toEqual([])
      expect(plan.skipped[0]?.reason).toMatch(/reserved/)
    } finally {
      await cleanup()
    }
  })

  it("keeps the first app's name when a second one computes the same MCP name", async () => {
    const { registry, cleanup } = await registryWith([
      { appId: "@t/one", prefix: "jobkit", tools: [tool("jobkit.list")] },
      { appId: "@t/two", prefix: "jobkit", tools: [tool("jobkit.list")] },
    ])
    try {
      const plan = await planExposedTools(registry)
      expect(plan.tools.map(t => [t.appId, t.name])).toEqual([["@t/one", "jobkit_list"]])
      expect(plan.skipped).toEqual([expect.objectContaining({ appId: "@t/two", name: "jobkit_list", reason: expect.stringContaining("@t/one") })])
    } finally {
      await cleanup()
    }
  })

  it("skips an app whose directory no longer exists", async () => {
    const { registry, cleanup } = await registryWith([{ appId: "@t/gone", prefix: "gone", tools: [tool("gone.list")] }])
    await cleanup()
    const plan = await planExposedTools(registry)
    expect(plan.tools).toEqual([])
    expect(plan.skipped[0]?.reason).toMatch(/no longer exists/)
  })
})
