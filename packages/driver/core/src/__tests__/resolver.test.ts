import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver } from "../define-provider.js"
import { resolveDriver } from "../resolver.js"
import type { DriverHandle } from "../types.js"

const tool = defineTool({
  id: "image-create",
  description: "Generate an image.",
  inputSchema: z.object({
    prompt: z.string(),
    style: z.string().optional(),
    seed: z.number().optional(),
  }),
  outputSchema: z.object({ url: z.string() }),
})

function p(opts: Partial<Parameters<typeof defineDriver>[0]>): DriverHandle {
  return defineDriver({
    id: opts.id ?? "prov",
    name: opts.name ?? opts.id ?? "prov",
    description: opts.description ?? "desc",
    kind: opts.kind ?? "http",
    implements: opts.implements ?? [
      { tool: "./tools/image-create/TOOL.md", version: "^1.0.0" },
    ],
    execute: opts.execute ?? { "image-create": async () => ({ url: "x" }) },
    ...opts,
  })
}

describe("resolveDriver — Phase 1 candidate filtering", () => {
  it("drops providers that don't implement the tool", () => {
    const candidates = [
      p({ id: "match", kind: "http" }),
      p({
        id: "no-match",
        kind: "http",
        implements: [{ tool: "./tools/other/TOOL.md", version: "^1" }],
        execute: { other: async () => undefined },
      }),
    ]
    const r = resolveDriver({ tool, candidates, context: {} })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("match")
  })

  it("respects driverConstraints.forbid on the contract", () => {
    const piiTool = defineTool({
      id: "pii",
      description: "PII redact.",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ redacted: z.string() }),
      driverConstraints: { forbid: ["http"] },
    })
    const candidates = [
      p({
        id: "http-provider",
        kind: "http",
        implements: [{ tool: "./tools/pii/TOOL.md", version: "^1" }],
        execute: { pii: async () => ({ redacted: "" }) },
      }),
      p({
        id: "sdk-provider",
        kind: "sdk",
        implements: [{ tool: "./tools/pii/TOOL.md", version: "^1" }],
        execute: { pii: async () => ({ redacted: "" }) },
      }),
    ]
    const r = resolveDriver({ tool: piiTool, candidates, context: {} })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("sdk-provider")
  })

  it("refuses calls using inputs the provider drops via schemaNarrowing", () => {
    const candidates = [
      p({
        id: "narrow",
        kind: "http",
        implements: [
          {
            tool: "./tools/image-create/TOOL.md",
            version: "^1",
            schemaNarrowing: { dropInputs: ["seed"] },
          },
        ],
      }),
    ]
    const r = resolveDriver({
      tool,
      candidates,
      context: {},
      inputKeys: ["prompt", "seed"],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("no_route")
  })
})

describe("resolveDriver — Phase 3 policy + region filtering", () => {
  it("drops providers without matching region when regionConstraint is set", () => {
    const candidates = [
      p({ id: "us", region: ["us-east-1"] }),
      p({ id: "eu", region: ["EU"] }),
    ]
    const r = resolveDriver({
      tool,
      candidates,
      context: { regionConstraint: "EU" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("eu")
  })

  it("keeps global providers in any regionConstraint", () => {
    const candidates = [p({ id: "global", region: ["global"] })]
    const r = resolveDriver({
      tool,
      candidates,
      context: { regionConstraint: "EU" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("global")
  })

  it("returns region_mismatch when no provider matches the region", () => {
    const candidates = [p({ id: "us", region: ["us-east-1"] })]
    const r = resolveDriver({
      tool,
      candidates,
      context: { regionConstraint: "EU" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("region_mismatch")
  })

  it("drops providers tagged with forbidden policy_tags", () => {
    const candidates = [
      p({ id: "third", policyTags: ["third-party-llm"] }),
      p({ id: "self", policyTags: ["self-hosted"] }),
    ]
    const r = resolveDriver({
      tool,
      candidates,
      context: { policyForbiddenTags: ["third-party-llm"] },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("self")
  })
})

describe("resolveDriver — Phase 4 pin override", () => {
  it("returns pinned provider when present", () => {
    const candidates = [p({ id: "prov-a" }), p({ id: "prov-b" })]
    const r = resolveDriver({
      tool,
      candidates,
      context: { pinnedProvider: "prov-b" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("prov-b")
  })

  it("fails with pinned_provider_unavailable when pin doesn't survive earlier phases", () => {
    const piiTool = defineTool({
      id: "pii",
      description: "PII redact.",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ redacted: z.string() }),
      driverConstraints: { forbid: ["http"] },
    })
    const candidates = [
      p({
        id: "blocked",
        kind: "http",
        implements: [{ tool: "./tools/pii/TOOL.md", version: "^1" }],
        execute: { pii: async () => ({ redacted: "" }) },
      }),
    ]
    const r = resolveDriver({
      tool: piiTool,
      candidates,
      context: { pinnedProvider: "blocked" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("pinned_provider_unavailable")
  })
})

describe("resolveDriver — Phase 5 cost ranking", () => {
  it("prefers contract's defaultDriver when surviving", () => {
    const toolWithDefault = defineTool({
      id: "image-create",
      description: "Generate.",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ url: z.string() }),
      defaultDriver: "preferred",
    })
    const candidates = [
      p({ id: "cheap", costOverride: { costUnitsPerCall: 1 } }),
      p({ id: "preferred", costOverride: { costUnitsPerCall: 10 } }),
    ]
    const r = resolveDriver({
      tool: toolWithDefault,
      candidates,
      context: {},
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("preferred")
  })

  it("ranks by cost_units_per_call ascending", () => {
    const candidates = [
      p({ id: "expensive", costOverride: { costUnitsPerCall: 10 } }),
      p({ id: "cheap", costOverride: { costUnitsPerCall: 1 } }),
      p({ id: "mid", costOverride: { costUnitsPerCall: 5 } }),
    ]
    const r = resolveDriver({ tool, candidates, context: {} })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("cheap")
  })

  it("breaks ties by kind preference (builtin > sdk > http > mcp > cli)", () => {
    const candidates = [
      p({ id: "cli-prov", kind: "cli", costOverride: { costUnitsPerCall: 0 } }),
      p({ id: "sdk-prov", kind: "sdk", costOverride: { costUnitsPerCall: 0 } }),
    ]
    const r = resolveDriver({ tool, candidates, context: {} })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("sdk-prov")
  })
})

describe("resolveDriver — Phase 2 capability gate", () => {
  it("drops providers with failed install via availability map", () => {
    const candidates = [p({ id: "broken" }), p({ id: "ok" })]
    const availability = new Map<string, { installFailed?: boolean }>()
    availability.set("broken", { installFailed: true })
    const r = resolveDriver({ tool, candidates, context: {}, availability })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("ok")
  })

  it("drops unauthed providers", () => {
    const candidates = [p({ id: "unauthed" }), p({ id: "authed" })]
    const availability = new Map([
      ["unauthed", { authState: "unauthed" as const }],
      ["authed", { authState: "authed" as const }],
    ])
    const r = resolveDriver({ tool, candidates, context: {}, availability })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provider.id).toBe("authed")
  })
})
