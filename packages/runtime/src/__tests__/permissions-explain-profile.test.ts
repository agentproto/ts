import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { decide } from "../permissions.js"
import { registerPermissionsTools } from "../permissions-tools.js"
import { resetProfileObservations } from "../profile-gate.js"
import type { SessionsRegistry } from "../sessions.js"

type Handler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

const caller = {
  id: "caller",
  accessProfile: { profileRef: "p-own", endpoint: "anthropic", method: "api-key" as const },
}

function explainer(selfRow: Record<string, unknown> = caller): Handler {
  let handler: Handler | undefined
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, h: Handler) => {
      if (name === "permissions_explain") handler = h
    },
  } as unknown as McpServer
  const registry = {
    get: (id: string) => (id === caller.id ? selfRow : undefined),
  } as unknown as SessionsRegistry
  registerPermissionsTools(server, {
    registry,
    callerSessionId: caller.id,
    sharedProfiles: ["p-shared"],
  })
  if (!handler) throw new Error("permissions_explain was not registered")
  return handler
}

describe("permissions_explain with an auth profile", () => {
  beforeEach(() => resetProfileObservations())
  afterEach(() => resetProfileObservations())

  it("allows a profile in the caller's set with the same decision as decide()", async () => {
    const res = await explainer()({ action: "auth.profile.use", profile: "p-shared" })
    const body = JSON.parse(res.content[0]!.text) as { ok: boolean; decision: Record<string, unknown> }
    const expected = decide(
      { kind: "session", session: caller },
      "auth.profile.use",
      { kind: "profile", ref: "p-shared" },
      { profiles: { callerAllowed: ["p-own", "p-shared"] } },
    )
    expect(body.ok).toBe(true)
    expect(body.decision).toMatchObject({
      allow: expected.allow,
      rule: expected.rule,
      authoritative: true,
    })
  })

  it("explains an external caller as the operator, like the spawn gate treats it", async () => {
    const res = await explainer({ id: caller.id, kind: "external" })({
      action: "auth.profile.use",
      profile: "p-other",
    })
    const body = JSON.parse(res.content[0]!.text) as { ok: boolean; decision: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.decision).toMatchObject({ allow: true, rule: "operator", authoritative: true })
  })

  it("denies a profile outside the caller's set with the same decision as decide()", async () => {
    const res = await explainer()({ action: "auth.profile.use", profile: "p-other" })
    const body = JSON.parse(res.content[0]!.text) as { ok: boolean; decision: Record<string, unknown> }
    const expected = decide(
      { kind: "session", session: caller },
      "auth.profile.use",
      { kind: "profile", ref: "p-other" },
      { profiles: { callerAllowed: ["p-own", "p-shared"] } },
    )
    expect(body.ok).toBe(true)
    expect(body.decision).toMatchObject({
      allow: false,
      rule: "profile.outside-parent-set",
      authoritative: true,
    })
    expect(expected.allow).toBe(false)
  })
})
