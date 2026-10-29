/**
 * `decide()` consults AIP-38 grants at call time (permissions.ts):
 *
 *  - an explicit deny removes the grant-derived reasons of `session.message`
 *    (sibling and peer), never a tree edge, the operator or the system;
 *  - a deny wins over an allow in the same policy or another one;
 *  - a revoked grant applies on the next call, because the context is read
 *    per call;
 *  - `tool.invoke` is decided by `evaluateToolInvoke`;
 *  - a context with no policy, or with allow grants only, changes nothing.
 *
 * Synthetic grants only: nothing here reads a daemon or a home directory.
 */

import { describe, expect, it } from "vitest"
import type { Grant, GrantInput } from "@agentproto/policy"

import { decide, type PermissionContext, type Principal } from "../permissions.js"
import type { MessageTreeNode } from "../session-message.js"

const P: MessageTreeNode = { id: "P" }
const A: MessageTreeNode = { id: "A", parentSessionId: "P" }
const B: MessageTreeNode = { id: "B", parentSessionId: "P" }
const G: MessageTreeNode = { id: "G", parentSessionId: "A" }
const S: MessageTreeNode = { id: "S" }
const FOREST = [P, A, B, G, S]

const as = (n: MessageTreeNode): Principal => ({ kind: "session", session: n })
const to = (n: MessageTreeNode) => ({ kind: "session", session: n }) as const
const operator: Principal = { kind: "operator", via: "anonymous-local" }
const system: Principal = { kind: "system" }

function grant(effect: "allow" | "deny", scope?: string, extra: Partial<Grant> = {}): Grant {
  return { principal: "*", effect, actions: [{ action: "session:message", ...(scope ? { scope } : {}) }], ...extra }
}

function ctx(inputs: readonly GrantInput[], extra: PermissionContext = {}): PermissionContext {
  return { messaging: { allowSiblings: true }, ...extra, policy: { inputs } }
}

describe("session.message: an explicit deny", () => {
  it("allows siblings by config and refuses them once a deny targets the recipient", () => {
    expect(decide(as(A), "session.message", to(B), ctx([])).allow).toBe(true)
    const d = decide(as(A), "session.message", to(B), ctx([grant("deny", "B")]))
    expect(d).toMatchObject({ allow: false, rule: "policy.explicit-deny", relation: "sibling", authoritative: true })
  })

  it("refuses even when another composed policy allows the same send", () => {
    const allowing = { default: "deny" as const, grants: [grant("allow", "B")] }
    const denying = { default: "deny" as const, grants: [grant("deny", "B")] }
    expect(decide(as(A), "session.message", to(B), ctx([allowing, denying])).allow).toBe(false)
    expect(decide(as(A), "session.message", to(B), ctx([denying, allowing])).allow).toBe(false)
    expect(decide(as(A), "session.message", to(B), ctx([allowing])).allow).toBe(true)
  })

  it("leaves other recipients and other senders alone", () => {
    const deny = [grant("deny", "B")]
    expect(decide(as(A), "session.message", to(P), ctx(deny)).allow).toBe(true)
    expect(decide(as(B), "session.message", to(A), ctx(deny)).allow).toBe(true)
  })

  it("never removes a tree edge, the operator or the system", () => {
    const denyAll = [grant("deny")]
    expect(decide(as(P), "session.message", to(A), ctx(denyAll))).toMatchObject({ allow: true, rule: "tree.parent" })
    expect(decide(as(A), "session.message", to(P), ctx(denyAll))).toMatchObject({ allow: true, rule: "tree.child" })
    expect(decide(operator, "session.message", to(A), ctx(denyAll)).allow).toBe(true)
    expect(decide(system, "session.message", to(A), ctx(denyAll)).allow).toBe(true)
    expect(decide({ kind: "relay", boxSessionId: "x", parentSessionId: "P" }, "session.message", to(P), ctx(denyAll)).allow).toBe(true)
  })

  it("removes a peer link the same way", () => {
    const x: MessageTreeNode = { id: "X", workspaceSlug: "w" }
    const y: MessageTreeNode = { id: "Y", workspaceSlug: "w" }
    expect(decide(as(x), "session.message", to(y), { policy: { inputs: [] } }).allow).toBe(true)
    expect(decide(as(x), "session.message", to(y), { policy: { inputs: [grant("deny", "Y")] } })).toMatchObject({
      allow: false,
      rule: "policy.explicit-deny",
      relation: "peer",
    })
  })

  it("applies a revoked grant on the next call, with no cached state", () => {
    const g = grant("deny", "B")
    expect(decide(as(A), "session.message", to(B), ctx([g])).allow).toBe(false)
    expect(decide(as(A), "session.message", to(B), ctx([{ ...g, revoked: true }])).allow).toBe(true)
    expect(decide(as(A), "session.message", to(B), ctx([g])).allow).toBe(false)
  })

  it("matches a label: scope against the recipient's operator label, and fails closed when it cannot be read", () => {
    const deny = [grant("deny", "label:ops")]
    const labelled = (id: string) => (id === "B" ? "ops" : undefined)
    expect(decide(as(A), "session.message", to(B), ctx(deny, { operatorLabelOf: labelled })).allow).toBe(false)
    expect(decide(as(B), "session.message", to(A), ctx(deny, { operatorLabelOf: labelled })).allow).toBe(true)
    expect(decide(as(A), "session.message", to(B), ctx(deny)).allow).toBe(false)
  })

  it("names the sender by its operator label as a session-label:// principal", () => {
    const deny = [grant("deny", "B", { principal: "session-label://ops" })]
    const labelOf = (id: string) => (id === "A" ? "ops" : undefined)
    expect(decide(as(A), "session.message", to(B), ctx(deny, { operatorLabelOf: labelOf })).allow).toBe(false)
    const other = [grant("deny", "B", { principal: "session-label://other" })]
    expect(decide(as(A), "session.message", to(B), ctx(other, { operatorLabelOf: labelOf })).allow).toBe(true)
  })

  it("refuses a grant-derived send when the grants are malformed, and keeps tree edges", () => {
    const bad = [{ principal: "*", actions: [] }] as unknown as GrantInput[]
    expect(decide(as(A), "session.message", to(B), ctx(bad))).toMatchObject({ allow: false, rule: "policy.invalid" })
    expect(decide(as(P), "session.message", to(A), ctx(bad)).allow).toBe(true)
  })

  it("makes an interrupt follow the refused message", () => {
    const d = decide(as(A), "session.message.interrupt", to(B), ctx([grant("deny", "B")], { messaging: { allowSiblings: true, agentInterrupt: "allow" } }))
    expect(d.allow).toBe(false)
  })
})

describe("a policy with only allow grants, or none, changes no messaging outcome", () => {
  it("matches the decision without a policy over every ordered pair", () => {
    const policies: GrantInput[][] = [
      [],
      [grant("allow")],
      [grant("allow", "B"), { default: "allow" as const }],
      [grant("allow", "label:ops"), grant("allow", "A", { revoked: true })],
    ]
    for (const allowSiblings of [true, false]) {
      for (const sender of [...FOREST, undefined]) {
        for (const recipient of FOREST) {
          const principal = sender ? as(sender) : operator
          const base = { messaging: { allowSiblings } }
          const without = decide(principal, "session.message", to(recipient), base)
          for (const inputs of policies) {
            const withPolicy = decide(principal, "session.message", to(recipient), { ...base, policy: { inputs } })
            expect(withPolicy).toEqual(without)
          }
        }
      }
    }
  })
})

describe("tool.invoke", () => {
  const principals = () => ["operator://pm-katchy"]
  const tool = (name: string, impl?: string) => ({ kind: "tool", name, ...(impl ? { implements: impl } : {}) }) as const
  const toolGrant = (effect: "allow" | "deny", scope?: string, action = "tool:invoke"): Grant => ({
    principal: "operator://pm-katchy",
    effect,
    actions: [{ action, ...(scope ? { scope } : {}) }],
  })
  const c = (inputs: readonly GrantInput[]): PermissionContext => ({ policy: { inputs, principals } })

  it("is not routed, and answers as before, without a policy", () => {
    expect(decide(operator, "tool.invoke", tool("pygmalion/cron_create"))).toMatchObject({
      allow: false,
      authoritative: false,
      rule: "not-routed",
    })
  })

  it("refuses a call a deny targets even when another policy allows the whole server", () => {
    const inputs = [
      { default: "deny" as const, grants: [toolGrant("allow", "pygmalion/*")] },
      { default: "deny" as const, grants: [toolGrant("deny", "pygmalion/cron_create")] },
    ]
    expect(decide(as(A), "tool.invoke", tool("pygmalion/cron_create"), c(inputs))).toMatchObject({
      allow: false,
      rule: "policy.explicit-deny",
      authoritative: false,
    })
    expect(decide(as(A), "tool.invoke", tool("pygmalion/cron_list"), c(inputs)).allow).toBe(true)
  })

  it("matches by <server>/<name> and not by a bare name, and qualifies a legacy built-in", () => {
    expect(decide(as(A), "tool.invoke", tool("pygmalion/cron_create"), c([toolGrant("allow", "cron_create")])).allow).toBe(false)
    expect(decide(as(A), "tool.invoke", tool("cron_create"), c([toolGrant("allow", "agentproto/cron_create")])).allow).toBe(true)
  })

  it("does not let <server>/* reach another server", () => {
    expect(decide(as(A), "tool.invoke", tool("pygmalion/x"), c([toolGrant("allow", "agentproto/*")])).allow).toBe(false)
  })

  it("refuses an implements-tool when a deny targets the implemented action", () => {
    const inputs = [toolGrant("allow", "katchy/*"), toolGrant("deny", undefined, "storage:commit")]
    expect(decide(as(A), "tool.invoke", tool("katchy/commit", "storage:commit"), c(inputs))).toMatchObject({
      allow: false,
      rule: "policy.explicit-deny",
    })
  })

  it("fails closed on a selector scope and on malformed grants", () => {
    expect(decide(as(A), "tool.invoke", tool("a/b"), c([toolGrant("allow", "selector:s")])).allow).toBe(false)
    expect(decide(as(A), "tool.invoke", tool("a/b"), c([toolGrant("allow"), toolGrant("deny", "selector:s")])).allow).toBe(false)
    const bad = [{ principal: "*" }] as unknown as GrantInput[]
    expect(decide(as(A), "tool.invoke", tool("a/b"), c(bad))).toMatchObject({ allow: false, rule: "policy.invalid" })
  })

  it("needs a tool resource", () => {
    expect(decide(as(A), "tool.invoke", { kind: "none" }, c([])).allow).toBe(false)
  })
})
