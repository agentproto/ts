/**
 * `permissions_explain` for `session.drive` answers `authoritative: true`,
 * picks the AIP-38 action from the optional `tool` (default `agent_prompt`)
 * and agrees with `checkDrive` for the same inputs.
 */

import { describe, expect, it } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Grant } from "@agentproto/policy"

import { checkDrive } from "../drive-gate.js"
import { registerPermissionsTools } from "../permissions-tools.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

type Handler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

const rows: Record<string, unknown> = {
  stranger: { id: "stranger" },
  target: { id: "target", parentSessionId: "parent" },
}
const registry = {
  get: (id: string) => rows[id],
} as unknown as SessionsRegistry

function explainer(grants: Grant[]): Handler {
  let handler: Handler | undefined
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, h: Handler) => {
      if (name === "permissions_explain") handler = h
    },
  } as unknown as McpServer
  registerPermissionsTools(server, {
    registry,
    callerSessionId: "stranger",
    messagingGrants: grants,
  })
  if (!handler) throw new Error("permissions_explain was not registered")
  return handler
}

async function explain(grants: Grant[], input: Record<string, unknown>) {
  const res = await explainer(grants)(input)
  return JSON.parse(res.content[0]!.text) as {
    ok: boolean
    decision: Record<string, unknown>
  }
}

const promptGrant: Grant = { principal: "*", effect: "allow", actions: [{ action: "session:prompt", scope: "target" }] }
const controlGrant: Grant = { principal: "*", effect: "allow", actions: [{ action: "session:control", scope: "target" }] }

describe("permissions_explain for session.drive", () => {
  it("is authoritative and defaults the tool to agent_prompt", async () => {
    const body = await explain([], { action: "session.drive", sessionId: "target" })
    expect(body.decision.authoritative).toBe(true)
    expect(body.decision.allow).toBe(false)
    expect(body.decision.reason).toContain('agent_prompt: session "target"')
  })

  it("picks the action from tool", async () => {
    const prompt = await explain([promptGrant], { action: "session.drive", sessionId: "target", tool: "agent_prompt" })
    expect(prompt.decision).toMatchObject({ allow: true, rule: "policy.matched-grant" })
    const control = await explain([promptGrant], {
      action: "session.drive",
      sessionId: "target",
      tool: "session_continue_fresh",
    })
    expect(control.decision).toMatchObject({ allow: false, rule: "owner-gate" })
    expect(control.decision.reason).toContain('session_continue_fresh: session "target"')
  })

  it("agrees with checkDrive for the same inputs", async () => {
    const target = rows.target as unknown as SessionDescriptor
    for (const [tool, grants] of [
      ["agent_prompt", [promptGrant]],
      ["agent_kill", [controlGrant]],
      ["session_restart", [promptGrant]],
      ["session_continue_fresh", []],
    ] as const) {
      const body = await explain([...grants], { action: "session.drive", sessionId: "target", tool })
      const drive = checkDrive({ registry, grants, callerSessionId: "stranger", target, tool })
      expect(body.decision.allow, tool).toBe(drive.ok)
    }
  })
})
