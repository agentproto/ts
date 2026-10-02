import { describe, expect, it } from "vitest"

import type { CapabilitiesInventoryView, CapabilityBundle, SessionCapabilitiesView } from "../client/types.js"
import { buildCapabilitiesTree, selectedSessionIdOf, type CapabilityNode } from "./capabilitiesTree.logic.js"

const inventory: CapabilitiesInventoryView = {
  mcp: {
    imported: [
      {
        id: "echo",
        name: "echo",
        alias: "Echo",
        type: "stdio",
        source: "claude",
        status: "connected",
        toolCount: 3,
        usedBySessions: ["s1"],
        reach: { "claude-code": "native", codex: "none" },
        alsoNativeIn: [{ source: "cursor", scope: "user", name: "echo", sameName: true }],
      },
      { id: "bad", name: "bad", type: "http", source: "cursor", status: "error", error: "boom", usedBySessions: [], reach: {} },
    ],
    discovered: [{ id: "d1", source: "goose", name: "d1", imported: false }],
  },
  skills: {
    byHarness: [
      { adapter: "hermes", target: { format: "flat-dir", dir: "~/.hermes/skills" }, installed: ["a"], native: [], spawnOption: true },
      { adapter: "codex", installed: [], native: [], spawnOption: false },
    ],
  },
}

const bundles: CapabilityBundle[] = [
  { id: "research", label: "Research", mcpImports: ["echo"], skills: ["a", "b"], includeDaemon: true, dangling: [] },
  { id: "all", label: "All", mcpImports: "*", skills: [], dangling: ["gone"] },
]

const caps: SessionCapabilitiesView = {
  sessionId: "s1",
  adapter: "claude-code",
  arm: "acp",
  model: "opus",
  mcpServers: [{ name: "echo", transport: "http" }],
  skills: ["a"],
  skillsApplied: false,
}

function search(nodes: CapabilityNode[], id: string): CapabilityNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = n.children ? search(n.children, id) : undefined
    if (hit) return hit
  }
  return undefined
}

function find(nodes: CapabilityNode[], id: string): CapabilityNode {
  const hit = search(nodes, id)
  if (!hit) throw new Error(`node ${id} not found`)
  return hit
}

describe("buildCapabilitiesTree", () => {
  it("lists imported MCPs with status, tool count and double-mount notes", () => {
    const tree = buildCapabilitiesTree({ inventory, bundles })
    const echo = find(tree, "mcp:echo")
    expect(echo.label).toBe("Echo")
    expect(echo.description).toBe("connected · 3 tools")
    expect(echo.tooltip).toContain("native by default in: claude-code")
    expect(echo.tooltip).toContain("also mounted natively in cursor")
    expect(find(tree, "mcp:bad").icon).toBe("error")
    expect(find(tree, "section:mcp").description).toBe("2")
  })

  it("summarizes bundles and flags dangling imports", () => {
    const tree = buildCapabilitiesTree({ inventory, bundles })
    expect(find(tree, "bundle:research").description).toBe("1 MCP · 2 skills · daemon /mcp")
    const all = find(tree, "bundle:all")
    expect(all.description).toBe("all MCPs · 0 skills")
    expect(all.icon).toBe("warning")
    expect(all.tooltip).toContain("gone")
  })

  it("shows skills only for harnesses that can take them", () => {
    const tree = buildCapabilitiesTree({ inventory, bundles })
    expect(find(tree, "skills:hermes").children?.map(c => c.label)).toEqual(["a"])
    expect(() => find(tree, "skills:codex")).toThrow()
  })

  it("prompts for a selection when no session is selected", () => {
    const section = find(buildCapabilitiesTree({ inventory, bundles }), "section:session")
    expect(section.children).toBeUndefined()
    expect(section.description).toBe("select one in Sessions")
  })

  it("shows what a selected session received and when skills are not applied", () => {
    const tree = buildCapabilitiesTree({ inventory, bundles, session: { id: "s1", label: "my chat", capabilities: caps } })
    expect(find(tree, "session:info").description).toBe("acp · opus")
    expect(find(tree, "session:mcp:echo").description).toBe("http")
    expect(find(tree, "session:skills").description).toBe("1 (not applied by claude-code)")
    expect(find(tree, "session:skill:a").description).toBe("recorded, not applied")
  })

  it("reports an empty session and a failed session read", () => {
    const empty = buildCapabilitiesTree({
      inventory,
      bundles,
      session: { id: "s1", label: "x", capabilities: { ...caps, mcpServers: [], skills: [], skillsApplied: true } },
    })
    expect(find(empty, "session:mcp:none").label).toBe("none mounted")
    const failed = buildCapabilitiesTree({ session: { id: "s1", label: "x", error: "no session found" } })
    expect(find(failed, "session:error").description).toBe("no session found")
  })

  it("keeps sections visible when a read fails", () => {
    const tree = buildCapabilitiesTree({ inventoryError: "HTTP 500", bundlesError: "HTTP 500" })
    expect(find(tree, "mcp:error").description).toBe("HTTP 500")
    expect(find(tree, "bundles:error").description).toBe("HTTP 500")
    expect(find(tree, "skills:error").description).toBe("HTTP 500")
  })

  it("explains an empty import set and counts discovered servers", () => {
    const tree = buildCapabilitiesTree({
      inventory: { ...inventory, mcp: { imported: [], discovered: inventory.mcp.discovered } },
      bundles: [],
    })
    expect(find(tree, "mcp:none").description).toBe("1 discovered server not imported yet")
    expect(find(tree, "bundles:none").label).toBe("No bundles")
  })
})

describe("selectedSessionIdOf", () => {
  it("reads the id of the first selected session node", () => {
    expect(selectedSessionIdOf([{ session: { id: "s9" }, children: [] }])).toBe("s9")
  })
  it("ignores groups, separators and empty selections", () => {
    expect(selectedSessionIdOf([])).toBeUndefined()
    expect(selectedSessionIdOf([{ label: "group" }])).toBeUndefined()
  })
})
