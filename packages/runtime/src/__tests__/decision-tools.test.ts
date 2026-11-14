/**
 * `decision_decide` — the MCP tool seam. A stub server captures the
 * registration; the handler is exercised end-to-end with the config-loader
 * seam (no JEV key → conservative default, no network) and a policy-parse
 * failure path.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, describe, expect, it } from "vitest"

import { registerDecisionTools } from "../decision-tools.js"
import { clearDecisionCache } from "@agentproto/decision"
import { setJevConfigLoader } from "../jev-client.js"
import { setMcpCredentialDeps } from "../mcp-credential-deps.js"

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "decision", "review-router.md")

type ToolHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>

function stubServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>()
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler)
    },
  } as unknown as McpServer
  return { server, tools }
}

afterEach(() => {
  clearDecisionCache()
  setJevConfigLoader(async () => ({}))
  setMcpCredentialDeps({})
})

describe("registerDecisionTools", () => {
  it("registers decision_decide; a no-key classifier run resolves to the conservative default", async () => {
    const { server, tools } = stubServer()
    registerDecisionTools(server)
    expect(tools.has("decision_decide")).toBe(true)

    const handler = tools.get("decision_decide")!
    const res = await handler({
      policy: readFileSync(FIXTURE, "utf8"),
      evidence: { changeTypes: "code", riskCategories: [], signals: [], complete: true },
    })
    const out = JSON.parse(res.content[0]!.text) as { choice: string; source: string; reason: string }
    expect(out.choice).toBe("deep")
    expect(out.source).toBe("default")
    expect(out.reason).toContain("classifier failed")
  })

  it("rule-certain evidence needs no key: docs-only resolves light with no classifier call", async () => {
    const { server, tools } = stubServer()
    registerDecisionTools(server)
    const res = await tools.get("decision_decide")!({
      policy: readFileSync(FIXTURE, "utf8"),
      evidence: { changeTypes: "docs-only", riskCategories: [], signals: [] },
    })
    const out = JSON.parse(res.content[0]!.text) as { choice: string; source: string }
    expect(out).toMatchObject({ choice: "light", source: "rule" })
  })

  it("a malformed policy returns ok:false with errors and decides nothing", async () => {
    const { server, tools } = stubServer()
    registerDecisionTools(server)
    const res = await tools.get("decision_decide")!({
      policy: "---\nschema: 1\nchoices: [a]\n---\n",
      evidence: {},
    })
    const out = JSON.parse(res.content[0]!.text) as { ok: false; errors: string[] }
    expect(out.ok).toBe(false)
    expect(out.errors.length).toBeGreaterThan(0)
  })
})
