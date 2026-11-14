/**
 * `permissions_explain` for a grant-admitted `session.message` answers the
 * same decision `decide()` enforces: rule `policy.matched-grant`, relation
 * `granted`.
 */

import { describe, expect, it } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Grant } from "@agentproto/policy"

import { decide } from "../permissions.js"
import { registerPermissionsTools } from "../permissions-tools.js"
import type { SessionsRegistry } from "../sessions.js"

type Handler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

const sender = { id: "sender", workspaceSlug: "app-agentik-pygmalion", cwd: "/ws/pygmalion" }
const recipient = { id: "recipient", workspaceSlug: "agentik-studio", cwd: "/ws/studio" }

function explainer(grants: Grant[]): Handler {
  let handler: Handler | undefined
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, h: Handler) => {
      if (name === "permissions_explain") handler = h
    },
  } as unknown as McpServer
  const rows: Record<string, unknown> = { sender, recipient }
  const registry = {
    get: (id: string) => rows[id],
  } as unknown as SessionsRegistry
  registerPermissionsTools(server, {
    registry,
    callerSessionId: sender.id,
    allowSameWorkspace: false,
    messagingGrants: grants,
    workspaceOfCwd: cwd => (cwd === "/ws/studio" ? "agentik-studio" : cwd === "/ws/pygmalion" ? "app-agentik-pygmalion" : undefined),
  })
  if (!handler) throw new Error("permissions_explain was not registered")
  return handler
}

describe("permissions_explain with explicit message grants", () => {
  it("reports policy.matched-grant for a grant-admitted pair", async () => {
    const grants: Grant[] = [
      { principal: "*", effect: "allow", actions: [{ action: "session:message", scope: "workspace:agentik-studio" }] },
    ]
    const res = await explainer(grants)({ action: "session.message", sessionId: recipient.id })
    const body = JSON.parse(res.content[0]!.text) as { ok: boolean; decision: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.decision).toMatchObject({
      allow: true,
      relation: "granted",
      rule: "policy.matched-grant",
      relations: [],
    })
    const expected = decide(
      { kind: "session", session: sender as never },
      "session.message",
      { kind: "session", session: recipient as never },
      {
        messaging: { allowSameWorkspace: false },
        workspaceOfCwd: cwd =>
          cwd === "/ws/studio" ? "agentik-studio" : cwd === "/ws/pygmalion" ? "app-agentik-pygmalion" : undefined,
        operatorLabelOf: () => undefined,
        parentOf: () => undefined,
        policy: { inputs: [{ default: "deny", grants }] },
      },
    )
    expect(body.decision).toMatchObject({ allow: expected.allow, rule: expected.rule, relation: expected.relation })
  })

  it("keeps the previous refusal when no grant matches", async () => {
    const res = await explainer([
      { principal: "*", effect: "allow", actions: [{ action: "session:message", scope: "workspace:nowhere" }] },
    ])({ action: "session.message", sessionId: recipient.id })
    const body = JSON.parse(res.content[0]!.text) as { decision: Record<string, unknown> }
    expect(body.decision).toMatchObject({ allow: false, rule: "tree.none" })
  })
})
