/**
 * Explicit AIP-38 `session:message` grants ADMIT a pair (permissions.ts).
 *
 * A matching allow whose scope names the RECIPIENT (session id, `label:` or
 * `workspace:`) admits a send the tree and the messaging switches refuse,
 * with relation `granted` and rule `policy.matched-grant`. A matching deny
 * still wins, `default: allow` never admits, and a malformed or expired grant
 * admits nothing. Tree edges, the operator, the system and the relay are
 * unchanged.
 */

import { describe, expect, it } from "vitest"
import type { Grant } from "@agentproto/policy"

import { decide, type PermissionContext, type Principal } from "../permissions.js"
import type { MessageTreeNode } from "../session-message.js"

const ANY = "*"

function grant(
  scope: string | undefined,
  extra: Partial<Grant> & { principal?: Grant["principal"] } = {},
): Grant {
  return {
    principal: ANY,
    effect: "allow",
    actions: [{ action: "session:message", ...(scope !== undefined ? { scope } : {}) }],
    ...extra,
  }
}

function ctx(inputs: Grant[], extra: PermissionContext = {}): PermissionContext {
  return {
    messaging: { allowSameWorkspace: false },
    ...extra,
    policy: { inputs, ...(extra.policy ?? {}) },
  }
}

const as = (n: MessageTreeNode): Principal => ({ kind: "session", session: n })
const to = (n: MessageTreeNode) => ({ kind: "session", session: n }) as const

const A: MessageTreeNode = { id: "A", workspaceSlug: "wa", cwd: "/ws/a" }
const B: MessageTreeNode = { id: "B", workspaceSlug: "wb", cwd: "/ws/b" }
const C: MessageTreeNode = { id: "C", workspaceSlug: "wc", cwd: "/ws/c" }
const P: MessageTreeNode = { id: "P" }
const CHILD: MessageTreeNode = { id: "CHILD", parentSessionId: "P" }
const SIB: MessageTreeNode = { id: "SIB", parentSessionId: "P" }

const workspaceOfCwd = (cwd: string) =>
  cwd === "/ws/a" ? "wa" : cwd === "/ws/b" ? "wb" : cwd === "/ws/c" ? "wc" : undefined

describe("session.message: an explicit allow grant admits the pair", () => {
  it("admits two roots by workspace: scope, relation granted, peerVerified undefined", () => {
    const d = decide(as(A), "session.message", to(B), ctx([grant("workspace:wb")], { workspaceOfCwd }))
    expect(d).toMatchObject({
      allow: true,
      relation: "granted",
      rule: "policy.matched-grant",
      relations: [],
      authoritative: true,
    })
    expect(d.peerVerified).toBeUndefined()
    expect(d.reason).toContain("a configured session:message grant admits the send")
    expect(d.reason).toContain("policy input 0")
  })

  it("does not admit when the workspace: scope names another slug", () => {
    expect(decide(as(A), "session.message", to(B), ctx([grant("workspace:wc")], { workspaceOfCwd }))).toMatchObject({
      allow: false,
      rule: "tree.none",
    })
  })

  it("matches a session-label:// principal against the SENDER's label only", () => {
    const labelled = (id: string) => (id === "A" ? "brain" : undefined)
    const labelledGrant = grant("B", { principal: "session-label://brain" })
    expect(decide(as(A), "session.message", to(B), ctx([labelledGrant], { operatorLabelOf: labelled })).allow).toBe(true)
    expect(decide(as(C), "session.message", to(B), ctx([labelledGrant], { operatorLabelOf: labelled })).allow).toBe(false)
    expect(decide(as(A), "session.message", to(B), ctx([labelledGrant]))).toMatchObject({ allow: false, rule: "tree.none" })
  })

  it("matches the recipient's label: scope and the plain session id", () => {
    const labels = (id: string) => (id === "B" ? "pm-simone" : undefined)
    expect(decide(as(A), "session.message", to(B), ctx([grant("label:pm-simone")], { operatorLabelOf: labels })).allow).toBe(true)
    expect(decide(as(A), "session.message", to(B), ctx([grant("B")])).allow).toBe(true)
    expect(decide(as(A), "session.message", to(B), ctx([grant("label:someone-else")], { operatorLabelOf: labels }))).toMatchObject({
      allow: false,
      rule: "tree.none",
    })
  })

  it("lets a matching deny beat the allow, in one policy and across composed ones, but never a tree edge", () => {
    const deny = grant("B", { effect: "deny" })
    // No relation held, so the deny simply prevents admission: the pair stays
    // refused. On a grant-derived reason it still reports policy.explicit-deny.
    expect(decide(as(A), "session.message", to(B), ctx([grant("B"), deny])).allow).toBe(false)
    expect(
      decide(as(SIB), "session.message", to(CHILD), {
        messaging: { allowSiblings: true },
        policy: { inputs: [grant("CHILD"), grant("CHILD", { effect: "deny" })] },
      }),
    ).toMatchObject({ allow: false, rule: "policy.explicit-deny" })
    const composed: PermissionContext = {
      messaging: { allowSameWorkspace: false },
      policy: {
        inputs: [
          { default: "deny", grants: [grant("B")] },
          { default: "deny", grants: [deny] },
        ],
      },
    }
    expect(decide(as(A), "session.message", to(B), composed).allow).toBe(false)
    expect(decide(as(P), "session.message", to(CHILD), ctx([deny]))).toMatchObject({
      allow: true,
      rule: "tree.parent",
    })
  })

  it("does not admit an expired or revoked grant", () => {
    const expired = grant("B", { ttl_seconds: 60, granted_at: "2025-01-01T00:00:00Z" })
    expect(
      decide(as(A), "session.message", to(B), {
        messaging: { allowSameWorkspace: false },
        policy: { inputs: [expired], now: Date.parse("2026-01-01T00:00:00Z") },
      }),
    ).toMatchObject({ allow: false, rule: "tree.none" })
    expect(decide(as(A), "session.message", to(B), ctx([grant("B", { revoked: true })]))).toMatchObject({
      allow: false,
      rule: "tree.none",
    })
  })

  it("does not let default: allow admit without a matching grant", () => {
    const d = decide(as(A), "session.message", to(B), {
      messaging: { allowSameWorkspace: false },
      policy: { inputs: [{ default: "allow", grants: [] }] },
    })
    expect(d).toMatchObject({ allow: false, rule: "tree.none" })
  })

  it("admits nothing from a malformed grant, and keeps a parent/child pair", () => {
    const bad = [{ principal: ANY, actions: [] }] as unknown as Grant[]
    expect(decide(as(A), "session.message", to(B), ctx(bad))).toMatchObject({ allow: false, rule: "tree.none" })
    expect(decide(as(P), "session.message", to(CHILD), ctx(bad)).allow).toBe(true)
    expect(decide(as(CHILD), "session.message", to(P), ctx(bad)).allow).toBe(true)
  })

  it("leaves the operator, the system and the relay unchanged", () => {
    const g = grant("B")
    expect(decide({ kind: "operator", via: "anonymous-local" }, "session.message", to(B), ctx([g]))).toMatchObject({
      allow: true,
      rule: "operator",
    })
    expect(decide({ kind: "system" }, "session.message", to(B), ctx([g]))).toMatchObject({ allow: true, rule: "system" })
    expect(
      decide({ kind: "relay", boxSessionId: "box", parentSessionId: "P" }, "session.message", to(P), ctx([g])),
    ).toMatchObject({ allow: true, rule: "relay.grant" })
    expect(
      decide({ kind: "relay", boxSessionId: "box", parentSessionId: "P" }, "session.message", to(B), ctx([g])),
    ).toMatchObject({ allow: false, rule: "relay.grant" })
  })

  it("makes an interrupt follow the message decision and agentInterrupt", () => {
    const allowInterrupt = ctx([grant("B")], { workspaceOfCwd, messaging: { allowSameWorkspace: false, agentInterrupt: "allow" } })
    expect(decide(as(A), "session.message.interrupt", to(B), allowInterrupt)).toMatchObject({ allow: true, rule: "messaging.agentInterrupt" })
    const denyInterrupt = ctx([grant("B")], { workspaceOfCwd, messaging: { allowSameWorkspace: false, agentInterrupt: "deny" } })
    expect(decide(as(A), "session.message.interrupt", to(B), denyInterrupt)).toMatchObject({ allow: false, rule: "messaging.agentInterrupt" })
    expect(decide(as(A), "session.message.interrupt", to(B), ctx([]))).toMatchObject({ allow: false, rule: "session.message" })
  })

  it("admits a sibling pair refused by allowSiblings, still reporting the sibling relation", () => {
    const d = decide(as(SIB), "session.message", to(CHILD), {
      messaging: { allowSiblings: false },
      policy: { inputs: [grant("CHILD")] },
    })
    expect(d).toMatchObject({
      allow: true,
      relation: "granted",
      rule: "policy.matched-grant",
      relations: ["sibling"],
    })
  })
})
