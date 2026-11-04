/**
 * Budget + classification guard for the named MCP surface profiles
 * (`tool-profiles.ts`).
 *
 * The daemon's tool surface is generated (`daemon-tool-names.generated.ts`),
 * so it grows whenever a new `register*Tools` pass lands. A new name that no
 * profile classifies would silently disappear from every narrow surface, so
 * this test fails until its author either adds it to a profile or lists it
 * explicitly in `FULL_ONLY_TOOLS`.
 */

import { describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { DAEMON_TOOL_NAMES } from "../daemon-tool-names.generated.js"
import { registerToolHelpTool } from "../tool-help-mcp.js"
import { withToolSubset } from "../tool-subset.js"
import {
  ADMIN_PROFILE_TOOLS,
  APP_UI_TOOL_WILDCARD,
  APPS_PROFILE_TOOLS,
  CLASSIFIED_TOOL_NAMES,
  CORE_PROFILE_TOOLS,
  FULL_ONLY_TOOLS,
  PROFILE_TOOLS,
  parseToolProfileList,
  resolveToolProfileAllowSet,
  resolveToolProfileSelection,
  type ToolProfileName,
} from "../tool-profiles.js"

const generated: ReadonlySet<string> = new Set(DAEMON_TOOL_NAMES)

function exactNames(names: readonly string[]): string[] {
  return names.filter(name => !name.endsWith("*"))
}

function expectAllGenerated(names: readonly string[], label: string): void {
  const unknown = exactNames(names).filter(name => !generated.has(name))
  expect(unknown, `${label} names that are not in daemon-tool-names.generated.ts`).toEqual([])
}

describe("MCP surface profile budgets", () => {
  it("keeps core at 30 to 45 tools", () => {
    expect(CORE_PROFILE_TOOLS.length).toBeGreaterThanOrEqual(30)
    expect(CORE_PROFILE_TOOLS.length).toBeLessThanOrEqual(45)
  })

  it("keeps orchestrator at 45 tools or fewer", () => {
    expect(PROFILE_TOOLS.orchestrator.length).toBeLessThanOrEqual(45)
  })

  it("keeps apps at 45 entries or fewer, including the dynamic panel wildcard", () => {
    expect(PROFILE_TOOLS.apps).toContain(APP_UI_TOOL_WILDCARD)
    expect(PROFILE_TOOLS.apps.length).toBeLessThanOrEqual(45)
  })

  it("keeps admin at 100 tools or fewer", () => {
    expect(PROFILE_TOOLS.admin.length).toBeLessThanOrEqual(100)
  })

  it("never duplicates a name inside a profile", () => {
    for (const [label, names] of Object.entries({
      core: CORE_PROFILE_TOOLS,
      orchestrator: PROFILE_TOOLS.orchestrator,
      apps: APPS_PROFILE_TOOLS,
      admin: ADMIN_PROFILE_TOOLS,
      fullOnly: FULL_ONLY_TOOLS,
    })) {
      expect(new Set(names).size, `${label} repeats a tool name`).toBe(names.length)
    }
  })

  it("only names tools that exist in the generated daemon surface", () => {
    expectAllGenerated(CORE_PROFILE_TOOLS, "core")
    expectAllGenerated(PROFILE_TOOLS.orchestrator, "orchestrator")
    expectAllGenerated(APPS_PROFILE_TOOLS, "apps")
    expectAllGenerated(ADMIN_PROFILE_TOOLS, "admin")
    expectAllGenerated(FULL_ONLY_TOOLS, "full-only")
  })

  it("classifies every generated daemon tool exactly once across profiles + full-only", () => {
    const missing = DAEMON_TOOL_NAMES.filter(name => !CLASSIFIED_TOOL_NAMES.has(name))
    expect(
      missing,
      "new daemon tool(s) are unclassified: add each to a named profile in " +
        "tool-profiles.ts, or to its explicit FULL_ONLY_TOOLS list if it should " +
        "only exist on the full surface",
    ).toEqual([])

    const stale = [...CLASSIFIED_TOOL_NAMES].filter(name => !generated.has(name))
    expect(
      stale,
      "tool-profiles.ts classifies name(s) no longer in daemon-tool-names.generated.ts",
    ).toEqual([])

    const named = new Set<string>([
      ...CORE_PROFILE_TOOLS,
      ...PROFILE_TOOLS.orchestrator,
      ...APPS_PROFILE_TOOLS,
      ...ADMIN_PROFILE_TOOLS,
    ])
    const overlap = FULL_ONLY_TOOLS.filter(name => named.has(name))
    expect(overlap, "FULL_ONLY_TOOLS entries also belong to a named profile").toEqual([])
  })

  it("lets full remain unrestricted and composes named profiles", () => {
    expect(resolveToolProfileAllowSet(undefined)).toBeUndefined()
    expect(resolveToolProfileAllowSet(["full"])).toBeUndefined()
    expect(resolveToolProfileAllowSet(["core", "full"])).toBeUndefined()

    const composed = resolveToolProfileAllowSet(["core", "apps"])
    expect(composed).toBeDefined()
    expect(composed!.has("agent_start")).toBe(true)
    expect(composed!.has(APP_UI_TOOL_WILDCARD)).toBe(true)
    expect(composed!.has("cron_list")).toBe(false)
  })

  it("parses comma lists and gives the per-request query precedence over config", () => {
    expect(parseToolProfileList("core, apps,core")).toEqual(["core", "apps"])
    expect(parseToolProfileList("nope")).toBeUndefined()
    expect(resolveToolProfileSelection({ query: ["admin"], config: "core" })).toEqual(["admin"])
    expect(resolveToolProfileSelection({ config: "core,apps" })).toEqual(["core", "apps"])
    expect(resolveToolProfileSelection({ query: ["nope"], config: "admin" })).toEqual(["admin"])
    expect(resolveToolProfileSelection({})).toBeUndefined()
  })

  it("exposes every named profile with a valid profile name", () => {
    const expected: ToolProfileName[] = ["core", "orchestrator", "apps", "admin"]
    expect(Object.keys(PROFILE_TOOLS).sort()).toEqual([...expected].sort())
  })
})

async function withProfileHelp(profile: ToolProfileName): Promise<{
  names: string[]
  callHelp: (name: string) => Promise<string>
  close: () => Promise<void>
}> {
  // Go through the same parser the `?profile=` query uses, so this covers
  // the wire value as well as the resolved allow set.
  const activeProfiles = parseToolProfileList(profile)
  expect(activeProfiles).toEqual([profile])
  const allow = resolveToolProfileAllowSet(activeProfiles)
  expect(allow).toBeDefined()
  const { server } = await createMcpServer({ specs: [], name: `profile-${profile}`, version: "0" })
  const scoped = withToolSubset(server, allow!)
  registerToolHelpTool(scoped, { activeProfiles })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await scoped.connect(serverTransport)
  const client = new Client({ name: `profile-${profile}-test`, version: "0" })
  await client.connect(clientTransport)

  const names = (await client.listTools()).tools.map(tool => tool.name)
  return {
    names,
    callHelp: async (name: string) => {
      const result = (await client.callTool({ name: "tool_help", arguments: { name } })) as {
        content?: Array<{ type: string; text: string }>
      }
      return result.content?.[0]?.text ?? ""
    },
    close: () => client.close(),
  }
}

describe("tool_help on narrow profiles", () => {
  it.each(["orchestrator", "apps", "admin"] as const)(
    "stays registered under ?profile=%s",
    async profile => {
      const help = await withProfileHelp(profile)
      try {
        expect(help.names).toContain("tool_help")
      } finally {
        await help.close()
      }
    },
  )

  it.each(["apps", "admin"] as const)(
    "resolveToolProfileAllowSet(?profile=%s) keeps tool_help",
    profile => {
      const profiles = parseToolProfileList(profile)
      expect(profiles).toEqual([profile])
      expect(resolveToolProfileAllowSet(profiles)?.has("tool_help")).toBe(true)
    },
  )

  it("names the profile that exposes a tool hidden from ?profile=apps", async () => {
    const help = await withProfileHelp("apps")
    try {
      expect(help.names).not.toContain("cron_list")
      const text = await help.callHelp("cron_list")
      expect(text).toContain("Not in the active profile (apps).")
      expect(text).toContain("Exposed by: admin, full.")
    } finally {
      await help.close()
    }
  })
})
