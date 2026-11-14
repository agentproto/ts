/**
 * `checkDrive` (drive-gate.ts): the five drive tools build the same
 * principal/context `decide()` uses and map each tool to its AIP-38 action.
 */

import { describe, expect, it } from "vitest"
import type { Grant } from "@agentproto/policy"

import { checkDrive, DRIVE_TOOL_ACTIONS } from "../drive-gate.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

const SESSIONS: Record<
  string,
  { id: string; parentSessionId?: string; operatorLabel?: string; cwd?: string }
> = {
  parent: { id: "parent" },
  target: { id: "target", parentSessionId: "parent", cwd: "/ws/studio", operatorLabel: "pm" },
  stranger: { id: "stranger" },
  labelled: { id: "labelled", operatorLabel: "brain" },
}

const registry = { get: (id: string) => SESSIONS[id] } as unknown as Pick<SessionsRegistry, "get">
const target = SESSIONS.target as unknown as SessionDescriptor

function drive(tool: string, grants?: readonly Grant[]): ReturnType<typeof checkDrive> {
  return checkDrive({
    registry,
    ...(grants !== undefined ? { grants } : {}),
    callerSessionId: "stranger",
    target,
    tool,
  })
}

describe("checkDrive", () => {
  it("maps each drive tool to its action", () => {
    expect(DRIVE_TOOL_ACTIONS).toEqual({
      agent_prompt: "session:prompt",
      agent_interrupt: "session:control",
      agent_kill: "session:control",
      session_restart: "session:control",
      session_continue_fresh: "session:control",
    })
  })

  it("an unknown tool maps to session:control", () => {
    const g: Grant = { principal: "*", effect: "allow", actions: [{ action: "session:control", scope: "target" }] }
    expect(drive("session_teleport", [g])).toEqual({ ok: true })
    const promptOnly: Grant = { principal: "*", effect: "allow", actions: [{ action: "session:prompt", scope: "target" }] }
    expect(drive("session_teleport", [promptOnly]).ok).toBe(false)
  })

  it("treats an id the registry does not hold as a session principal", () => {
    const g: Grant = { principal: "*", effect: "allow", actions: [{ action: "session:control", scope: "target" }] }
    expect(drive("agent_kill", [g])).toEqual({ ok: true })
    expect(drive("agent_kill").ok).toBe(false)
  })

  it("returns the legacy refusal message, tool name included", () => {
    const r = drive("session_restart")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('session_restart: session "target"')
  })

  it("reads the caller's operator label from the registry for a session-label principal", () => {
    const g: Grant = {
      principal: "session-label://brain",
      effect: "allow",
      actions: [{ action: "session:control", scope: "target" }],
    }
    const call = (callerSessionId: string) =>
      checkDrive({ registry, grants: [g], callerSessionId, target, tool: "agent_kill" })
    expect(call("labelled")).toEqual({ ok: true })
    expect(call("stranger").ok).toBe(false)
  })

  it("reads the target's operator label from the registry for a label: scope", () => {
    const call = (scope: string) =>
      checkDrive({
        registry,
        grants: [{ principal: "*", effect: "allow", actions: [{ action: "session:prompt", scope }] }],
        callerSessionId: "stranger",
        target,
        tool: "agent_prompt",
      })
    expect(call("label:pm")).toEqual({ ok: true })
    expect(call("label:other").ok).toBe(false)
  })

  it("a session:prompt grant admits agent_prompt and not agent_kill", () => {
    const g: Grant = { principal: "*", effect: "allow", actions: [{ action: "session:prompt", scope: "target" }] }
    expect(drive("agent_prompt", [g])).toEqual({ ok: true })
    expect(drive("agent_kill", [g]).ok).toBe(false)
  })

  it("a session:control grant admits the four control tools and not agent_prompt", () => {
    const g: Grant = { principal: "*", effect: "allow", actions: [{ action: "session:control", scope: "target" }] }
    for (const tool of ["agent_interrupt", "agent_kill", "session_restart", "session_continue_fresh"]) {
      expect(drive(tool, [g]), tool).toEqual({ ok: true })
    }
    expect(drive("agent_prompt", [g]).ok).toBe(false)
  })
})
