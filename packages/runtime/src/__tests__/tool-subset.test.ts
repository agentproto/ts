/**
 * Unit coverage for the tool-subset guards (tool-subset.ts) —
 * `withToolSubset` (allowlist, used by the orchestrator sub-gateway)
 * and `withToolExclusion` (denylist, used by the plain `/mcp` gateway
 * to enforce the spawn-role-profiles tool gate — see role.ts).
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { withToolSubset, withToolExclusion } from "../tool-subset.js"

function registerProbeTools(server: McpServer, names: readonly string[]): void {
  for (const name of names) {
    server.tool(name, `probe tool ${name}`, {}, async () => ({
      content: [{ type: "text", text: name }],
    }))
  }
}

function registerProbeToolsViaRegisterTool(
  server: McpServer,
  names: readonly string[],
): void {
  for (const name of names) {
    server.registerTool(
      name,
      { description: `probe tool ${name}`, inputSchema: {} },
      async () => ({ content: [{ type: "text", text: name }] }),
    )
  }
}

function registeredToolNames(server: McpServer): string[] {
  // `McpServer` exposes its registered tools on `_registeredTools` in
  // the current SDK version — reach in rather than spinning up a full
  // transport just to call `tools/list` for a unit test.
  const internal = server as unknown as { _registeredTools?: Record<string, unknown> }
  return Object.keys(internal._registeredTools ?? {})
}

describe("withToolExclusion", () => {
  it("drops only the excluded names; everything else registers", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" })
    const guarded = withToolExclusion(server, new Set(["agent_start", "agent_prompt"]))
    registerProbeTools(guarded, ["agent_start", "agent_prompt", "command_execute", "file_read"])
    const names = registeredToolNames(server).sort()
    expect(names).toEqual(["command_execute", "file_read"])
  })

  it("is a no-op pass-through when the excluded set is empty", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" })
    const guarded = withToolExclusion(server, new Set())
    registerProbeTools(guarded, ["agent_start", "command_execute"])
    expect(registeredToolNames(server).sort()).toEqual(["agent_start", "command_execute"])
  })

  it("also guards registerTool registrations", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" })
    const guarded = withToolExclusion(server, new Set(["agent_start"]))
    registerProbeToolsViaRegisterTool(guarded, ["agent_start", "command_execute"])
    expect(registeredToolNames(server)).toEqual(["command_execute"])
  })
})

describe("withToolSubset (existing allowlist guard, sanity check)", () => {
  it("keeps only names in the subset", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" })
    const guarded = withToolSubset(server, new Set(["agent_start"]))
    registerProbeTools(guarded, ["agent_start", "command_execute"])
    expect(registeredToolNames(server)).toEqual(["agent_start"])
  })

  it("also guards registerTool registrations", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" })
    const guarded = withToolSubset(server, new Set(["agent_start"]))
    registerProbeToolsViaRegisterTool(guarded, ["agent_start", "command_execute"])
    expect(registeredToolNames(server)).toEqual(["agent_start"])
  })
})
