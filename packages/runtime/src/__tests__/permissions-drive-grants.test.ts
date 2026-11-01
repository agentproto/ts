/**
 * Explicit AIP-38 `session:prompt` / `session:control` grants ADMIT a drive
 * call through `decide()` (permissions.ts).
 *
 * The legacy owner gate is evaluated first and unchanged. Only when it
 * refuses, and only for a session principal with a policy, a matching allow
 * under `defaults.messaging.grants` admits the call. A matching deny wins,
 * `default: allow` never admits, a malformed or expired grant admits
 * nothing, and a `session:message` grant never admits a drive call.
 */

import { describe, expect, it } from "vitest"
import type { Grant } from "@agentproto/policy"

import {
  decide,
  type PermissionContext,
  type PermissionResource,
  type Principal,
} from "../permissions.js"
import type { MessageTreeNode } from "../session-message.js"

type DriveTool = "agent_prompt" | "agent_interrupt" | "agent_kill" | "session_restart" | "session_continue_fresh"

const DRIVE_TOOLS: DriveTool[] = [
  "agent_prompt",
  "agent_interrupt",
  "agent_kill",
  "session_restart",
  "session_continue_fresh",
]

const STRANGER: MessageTreeNode = { id: "stranger" }
const PARENT: MessageTreeNode = { id: "parent", parentSessionId: "root" }
const ROOT: MessageTreeNode = { id: "root" }
const TARGET: MessageTreeNode = { id: "target", parentSessionId: "parent", cwd: "/ws/studio" }

const PARENTS: Record<string, string | undefined> = {
  target: "parent",
  parent: "root",
  root: undefined,
}
const LABELS: Record<string, string | undefined> = { target: "pm" }

const parentOf = (id: string) => PARENTS[id]
const operatorLabelOf = (id: string) => LABELS[id]

function actionOf(tool: DriveTool): "session:prompt" | "session:control" {
  return tool === "agent_prompt" ? "session:prompt" : "session:control"
}

function res(tool: DriveTool, session: MessageTreeNode = TARGET): PermissionResource {
  return {
    kind: "session",
    session,
    drive: { tool, action: actionOf(tool) },
  } as PermissionResource
}

function grant(
  action: "session:message" | "session:prompt" | "session:control",
  scope: string | undefined,
  extra: Partial<Grant> & { principal?: Grant["principal"] } = {},
): Grant {
  return {
    principal: "*",
    effect: "allow",
    actions: [{ action, ...(scope !== undefined ? { scope } : {}) }],
    ...extra,
  }
}

function ctx(grants: Grant[], extra: PermissionContext = {}): PermissionContext {
  return {
    parentOf,
    operatorLabelOf,
    ...extra,
    policy: { inputs: [{ default: "deny", grants }], ...(extra.policy ?? {}) },
  }
}

const as = (n: MessageTreeNode): Principal => ({ kind: "session", session: n })
const operator: Principal = { kind: "operator", via: "anonymous-local" }

describe("session.drive is authoritative", () => {
  it("is authoritative for the operator, a session, the system and a relay", () => {
    expect(decide(operator, "session.drive", res("agent_prompt"), ctx([])).authoritative).toBe(true)
    expect(decide(as(STRANGER), "session.drive", res("agent_prompt"), ctx([])).authoritative).toBe(true)
    expect(decide({ kind: "system" }, "session.drive", res("agent_prompt"), ctx([])).authoritative).toBe(true)
    expect(
      decide({ kind: "relay", boxSessionId: "box", parentSessionId: "parent" }, "session.drive", res("agent_prompt"), ctx([]))
        .authoritative,
    ).toBe(true)
  })
})

describe("explicit session:p prompt and session:control grants admit a drive call", () => {
  it("(a) a session:prompt grant admits agent_prompt and not agent_kill", () => {
    const g = grant("session:prompt", "target")
    const admitted = decide(as(STRANGER), "session.drive", res("agent_prompt"), ctx([g]))
    expect(admitted).toMatchObject({
      allow: true,
      rule: "policy.matched-grant",
      authoritative: true,
    })
    expect(admitted.reason).toContain("a configured session:prompt grant admits the call")
    expect(decide(as(STRANGER), "session.drive", res("agent_kill"), ctx([g]))).toMatchObject({
      allow: false,
      rule: "owner-gate",
    })
  })

  it("(b) a session:control grant admits the four control tools and not agent_prompt", () => {
    const g = grant("session:control", "target")
    for (const tool of DRIVE_TOOLS.filter(t => t !== "agent_prompt")) {
      const d = decide(as(STRANGER), "session.drive", res(tool), ctx([g]))
      expect(d, tool).toMatchObject({ allow: true, rule: "policy.matched-grant" })
    }
    expect(decide(as(STRANGER), "session.drive", res("agent_prompt"), ctx([g]))).toMatchObject({
      allow: false,
      rule: "owner-gate",
    })
  })

  it("(c) a session-label:// principal admits only a caller carrying that label", () => {
    const g = grant("session:control", "target", { principal: "session-label://brain" })
    const labelled = (id: string) => (id === "brain-session" ? "brain" : undefined)
    const brain: MessageTreeNode = { id: "brain-session" }
    expect(
      decide(as(brain), "session.drive", res("agent_kill"), ctx([g], { operatorLabelOf: labelled })).allow,
    ).toBe(true)
    expect(
      decide(as(STRANGER), "session.drive", res("agent_kill"), ctx([g], { operatorLabelOf: labelled })).allow,
    ).toBe(false)
  })

  it("(d) a label: or workspace: scope on the target admits; another label or slug does not", () => {
    const workspaceOfCwd = (cwd: string) => (cwd === "/ws/studio" ? "agentik-studio" : undefined)
    expect(
      decide(as(STRANGER), "session.drive", res("agent_prompt"), ctx([grant("session:prompt", "label:pm")])).allow,
    ).toBe(true)
    expect(
      decide(as(STRANGER), "session.drive", res("agent_prompt"), ctx([grant("session:prompt", "label:other")])).allow,
    ).toBe(false)
    expect(
      decide(
        as(STRANGER),
        "session.drive",
        res("agent_prompt"),
        ctx([grant("session:prompt", "workspace:agentik-studio")], { workspaceOfCwd }),
      ).allow,
    ).toBe(true)
    expect(
      decide(
        as(STRANGER),
        "session.drive",
        res("agent_prompt"),
        ctx([grant("session:prompt", "workspace:elsewhere")], { workspaceOfCwd }),
      ).allow,
    ).toBe(false)
  })

  it("(e) a matching deny beats the allow, in one policy and across composed policies", () => {
    const allow = grant("session:control", "target")
    const deny = grant("session:control", "target", { effect: "deny" })
    expect(decide(as(STRANGER), "session.drive", res("agent_kill"), ctx([allow, deny])).allow).toBe(false)
    const composed: PermissionContext = {
      parentOf,
      operatorLabelOf,
      policy: {
        inputs: [
          { default: "deny", grants: [allow] },
          { default: "deny", grants: [deny] },
        ],
      },
    }
    expect(decide(as(STRANGER), "session.drive", res("agent_kill"), composed).allow).toBe(false)
  })

  it("(f) an expired or revoked grant does not admit", () => {
    const expired = grant("session:control", "target", {
      ttl_seconds: 60,
      granted_at: "2025-01-01T00:00:00Z",
    })
    expect(
      decide(as(STRANGER), "session.drive", res("agent_kill"), {
        parentOf,
        operatorLabelOf,
        policy: { inputs: [{ default: "deny", grants: [expired] }], now: Date.parse("2026-01-01T00:00:00Z") },
      }).allow,
    ).toBe(false)
    expect(
      decide(as(STRANGER), "session.drive", res("agent_kill"), ctx([grant("session:control", "target", { revoked: true })])).allow,
    ).toBe(false)
  })

  it("(g) default: allow with no matching grant does not admit", () => {
    const d = decide(as(STRANGER), "session.drive", res("agent_kill"), {
      parentOf,
      operatorLabelOf,
      policy: { inputs: [{ default: "allow", grants: [] }] },
    })
    expect(d).toMatchObject({ allow: false, rule: "owner-gate" })
  })

  it("(h) a malformed grant admits nothing; owner, parent and operator still pass", () => {
    const bad = [{ principal: "*", actions: [] }] as unknown as Grant[]
    expect(decide(as(STRANGER), "session.drive", res("agent_kill"), ctx(bad)).allow).toBe(false)
    expect(decide(as(PARENT), "session.drive", res("agent_kill"), ctx(bad)).allow).toBe(true)
    expect(decide(as(TARGET), "session.drive", res("agent_kill"), ctx(bad)).allow).toBe(true)
    expect(decide(as(ROOT), "session.drive", res("agent_kill"), ctx(bad)).allow).toBe(true)
    expect(decide(operator, "session.drive", res("agent_kill"), ctx(bad)).allow).toBe(true)
  })

  it("(i) the refusal text is the legacy text and names the tool", () => {
    const d = decide(as(STRANGER), "session.drive", res("agent_kill"), ctx([grant("session:control", "nowhere")]))
    expect(d.allow).toBe(false)
    expect(d.reason).toContain('agent_kill: session "target"')
    for (const tool of DRIVE_TOOLS) {
      const decision = decide(as(STRANGER), "session.drive", res(tool), ctx([]))
      expect(decision.reason, tool).toContain(`${tool}: session "target"`)
    }
  })

  it("(j) an unknown caller id is admitted by a * grant, refused without one", () => {
    const unknown: MessageTreeNode = { id: "unknown" }
    expect(
      decide(as(unknown), "session.drive", res("agent_kill"), ctx([grant("session:control", "target")])).allow,
    ).toBe(true)
    expect(decide(as(unknown), "session.drive", res("agent_kill"), ctx([])).allow).toBe(false)
  })

  it("(k) a session:message grant never admits a drive call", () => {
    const g = grant("session:message", "target")
    for (const tool of DRIVE_TOOLS) {
      expect(decide(as(STRANGER), "session.drive", res(tool), ctx([g])).allow, tool).toBe(false)
    }
  })
})
