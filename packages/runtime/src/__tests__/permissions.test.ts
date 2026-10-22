/**
 * `decide()` (permissions.ts): the one decision point.
 *
 *  - table-driven `session.message` / `session.message.interrupt` decisions
 *    over every relation;
 *  - a parity sweep pinning TODAY's messaging ACL (`resolveRelation` +
 *    `isMessageAllowed`, what `message_send` enforced before this module)
 *    over every ordered pair of a small forest;
 *  - `session.drive` mirrors the owner gate exactly;
 *  - unrouted actions are declared but never claim to be authoritative;
 *  - the `registry.sendMessage` sink refuses a decision that does not allow
 *    the message it carries.
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assertDecisionAllows,
  collectMessageRelations,
  decide,
  PERMISSION_ACTIONS,
  PERMISSION_ACTION_INFO,
  PermissionDeniedError,
  type Principal,
} from "../permissions.js"
import {
  createSessionMessage,
  isMessageAllowed,
  resolveRelation,
  type MessageTreeNode,
} from "../session-message.js"
import { checkSessionOwnerGate } from "../session-owner.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

// P ─┬─ A ── G
//    └─ B
// S (stranger root), T (another root) ── U
const P: MessageTreeNode = { id: "P" }
const A: MessageTreeNode = { id: "A", parentSessionId: "P" }
const B: MessageTreeNode = { id: "B", parentSessionId: "P" }
const G: MessageTreeNode = { id: "G", parentSessionId: "A" }
const S: MessageTreeNode = { id: "S" }
const T: MessageTreeNode = { id: "T" }
const U: MessageTreeNode = { id: "U", parentSessionId: "T" }
const FOREST = [P, A, B, G, S, T, U]

const as = (n: MessageTreeNode): Principal => ({ kind: "session", session: n })
const operator: Principal = { kind: "operator", via: "anonymous-local" }
const to = (n: MessageTreeNode) => ({ kind: "session", session: n }) as const

describe("decide(session.message): relation table", () => {
  const rows: Array<{
    name: string
    principal: Principal
    recipient: MessageTreeNode
    allowSiblings: boolean
    allow: boolean
    relation?: string
    rule: string
  }> = [
    { name: "parent -> child", principal: as(P), recipient: A, allowSiblings: false, allow: true, relation: "parent", rule: "tree.parent" },
    { name: "child -> parent", principal: as(A), recipient: P, allowSiblings: false, allow: true, relation: "child", rule: "tree.child" },
    { name: "sibling, allowSiblings off", principal: as(A), recipient: B, allowSiblings: false, allow: false, relation: "sibling", rule: "messaging.allowSiblings" },
    { name: "sibling, allowSiblings on", principal: as(A), recipient: B, allowSiblings: true, allow: true, relation: "sibling", rule: "messaging.allowSiblings" },
    { name: "grandparent -> grandchild", principal: as(P), recipient: G, allowSiblings: true, allow: false, rule: "tree.none" },
    { name: "grandchild -> grandparent", principal: as(G), recipient: P, allowSiblings: true, allow: false, rule: "tree.none" },
    { name: "uncle -> nephew", principal: as(B), recipient: G, allowSiblings: true, allow: false, rule: "tree.none" },
    { name: "stranger", principal: as(S), recipient: A, allowSiblings: true, allow: false, rule: "tree.none" },
    { name: "two roots are not siblings", principal: as(S), recipient: T, allowSiblings: true, allow: false, rule: "tree.none" },
    { name: "self", principal: as(A), recipient: A, allowSiblings: true, allow: false, rule: "self" },
    { name: "anonymous local caller = operator", principal: operator, recipient: G, allowSiblings: false, allow: true, relation: "human", rule: "operator" },
    { name: "operator with credential", principal: { kind: "operator", via: "credential" }, recipient: S, allowSiblings: false, allow: true, relation: "human", rule: "operator" },
    { name: "system", principal: { kind: "system" }, recipient: U, allowSiblings: false, allow: true, relation: "system", rule: "system" },
    { name: "relay grant -> its parent", principal: { kind: "relay", boxSessionId: "box1", parentSessionId: "P" }, recipient: P, allowSiblings: false, allow: true, relation: "child", rule: "relay.grant" },
    { name: "relay grant -> another session", principal: { kind: "relay", boxSessionId: "box1", parentSessionId: "P" }, recipient: A, allowSiblings: true, allow: false, rule: "relay.grant" },
  ]
  it.each(rows)("$name", row => {
    const d = decide(row.principal, "session.message", to(row.recipient), {
      messaging: { allowSiblings: row.allowSiblings },
    })
    expect(d.action).toBe("session.message")
    expect(d.authoritative).toBe(true)
    expect(d.resourceId).toBe(row.recipient.id)
    expect(d.allow).toBe(row.allow)
    expect(d.rule).toBe(row.rule)
    if (row.relation) expect(d.relation).toBe(row.relation)
    else expect(d.relation).toBeUndefined()
    expect(d.reason.length).toBeGreaterThan(0)
  })

  it("collects every relation that holds, and reports the strongest", () => {
    // A corrupt two-cycle: each is the other's parent. Both relations hold.
    const x: MessageTreeNode = { id: "x", parentSessionId: "y" }
    const y: MessageTreeNode = { id: "y", parentSessionId: "x" }
    expect(collectMessageRelations(as(x), y)).toEqual(["parent", "child"])
    expect(decide(as(x), "session.message", to(y)).relation).toBe("parent")
    expect(collectMessageRelations(as(A), B)).toEqual(["sibling"])
    expect(collectMessageRelations(as(S), A)).toEqual([])
  })

  it("a missing recipient is a refusal, not a throw", () => {
    const d = decide(as(A), "session.message", { kind: "none" })
    expect(d).toMatchObject({ allow: false, rule: "resource" })
  })
})

describe("decide(session.message) pins the pre-existing messaging ACL", () => {
  // `resolveRelation` + `isMessageAllowed` is exactly what `message_send`
  // enforced before decide() existed. Every ordered pair (plus the
  // anonymous sender) must decide the same way, with the same relation.
  for (const allowSiblings of [false, true]) {
    it(`every ordered pair agrees (allowSiblings=${allowSiblings})`, () => {
      const senders: Array<MessageTreeNode | undefined> = [undefined, ...FOREST]
      let checked = 0
      for (const sender of senders) {
        for (const recipient of FOREST) {
          const legacyRelation = resolveRelation(sender, recipient)
          const legacy = isMessageAllowed(legacyRelation, { allowSiblings })
          const d = decide(sender ? as(sender) : operator, "session.message", to(recipient), {
            messaging: { allowSiblings },
          })
          expect({ pair: `${sender?.id ?? "-"}->${recipient.id}`, allow: d.allow }).toEqual({
            pair: `${sender?.id ?? "-"}->${recipient.id}`,
            allow: legacy,
          })
          if (legacy) expect(d.relation).toBe(legacyRelation)
          checked++
        }
      }
      expect(checked).toBe(8 * 7)
    })
  }
})

describe("decide(session.message.interrupt)", () => {
  const rows: Array<{ name: string; principal: Principal; agentInterrupt?: "allow" | "deny"; allow: boolean }> = [
    { name: "operator, default policy", principal: operator, allow: true },
    { name: "operator, deny policy", principal: operator, agentInterrupt: "deny", allow: true },
    { name: "session, default policy", principal: as(A), allow: false },
    { name: "session, deny", principal: as(A), agentInterrupt: "deny", allow: false },
    { name: "session, allow", principal: as(A), agentInterrupt: "allow", allow: true },
    { name: "relay, default", principal: { kind: "relay", boxSessionId: "b", parentSessionId: "P" }, allow: false },
    { name: "relay, allow", principal: { kind: "relay", boxSessionId: "b", parentSessionId: "P" }, agentInterrupt: "allow", allow: true },
  ]
  it.each(rows)("$name", row => {
    const d = decide(row.principal, "session.message.interrupt", to(P), {
      messaging: row.agentInterrupt ? { agentInterrupt: row.agentInterrupt } : {},
    })
    expect(d.allow).toBe(row.allow)
    expect(d.authoritative).toBe(true)
  })

  it("never grants an interrupt on a session the principal cannot message", () => {
    const ctx = { messaging: { agentInterrupt: "allow" as const } }
    for (const recipient of [A, T, G]) {
      const d = decide(as(S), "session.message.interrupt", to(recipient), ctx)
      expect(d).toMatchObject({ allow: false, rule: "session.message", authoritative: true })
    }
    // siblings with allowSiblings off cannot message, so cannot interrupt
    expect(decide(as(A), "session.message.interrupt", to(B), ctx).allow).toBe(false)
    expect(
      decide(as(A), "session.message.interrupt", to(B), {
        messaging: { agentInterrupt: "allow", allowSiblings: true },
      }).allow,
    ).toBe(true)
    // a relay grant only reaches its own parent
    const relay: Principal = { kind: "relay", boxSessionId: "b", parentSessionId: "P" }
    expect(decide(relay, "session.message.interrupt", to(A), ctx).allow).toBe(false)
  })
})

describe("decide(session.drive) mirrors the owner gate", () => {
  it("agrees with checkSessionOwnerGate on every pair, including allowPromptFrom", () => {
    const targets = [...FOREST, { id: "Q", parentSessionId: "P", allowPromptFrom: ["S"] }]
    const parentOf = (id: string) => targets.find(t => t.id === id)?.parentSessionId
    for (const caller of [undefined, ...FOREST]) {
      for (const target of targets) {
        const gate = checkSessionOwnerGate({ callerSessionId: caller?.id, target, tool: "x", parentOf })
        const d = decide(caller ? as(caller) : operator, "session.drive", to(target), { parentOf })
        expect(d.allow).toBe(gate.ok)
        expect(d.authoritative).toBe(false)
      }
    }
  })
})

describe("action vocabulary", () => {
  it("declares every action, and only the messaging pair is routed", () => {
    for (const a of PERMISSION_ACTIONS) expect(PERMISSION_ACTION_INFO[a]).toBeDefined()
    expect(PERMISSION_ACTIONS.filter(a => PERMISSION_ACTION_INFO[a].routed)).toEqual([
      "session.message",
      "session.message.interrupt",
    ])
  })
  it("an unrouted action is never reported as authoritative", () => {
    for (const a of PERMISSION_ACTIONS) {
      if (PERMISSION_ACTION_INFO[a].routed || a === "session.drive") continue
      const d = decide(operator, a, { kind: "none" })
      expect(d).toMatchObject({ action: a, allow: false, authoritative: false, rule: "not-routed" })
    }
  })
})

describe("the sendMessage sink checks the decision it is handed", () => {
  const idle = (sessionId: string): AgentSessionLike => ({
    sessionId,
    // eslint-disable-next-line require-yield
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
  })

  it("refuses a deny, a decision for another recipient, and a decision for another action", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "perm-sink-"))
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    try {
      const p = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: idle("p"), adapterSlug: "fake" })
      // Another workspace: same-workspace peers are allowed by default, and
      // this test needs a decision that is genuinely denied.
      const s = registry.spawnAgent({ workspaceSlug: "other", cwd: "/tmp", agentSession: idle("s"), adapterSlug: "fake" })
      const msg = createSessionMessage({ to: p.id, from: { relation: "human" }, text: "x", urgency: "fyi" })

      const deny = decide(as(s), "session.message", to(p))
      expect(deny.allow).toBe(false)
      await expect(registry.sendMessage(msg, { decision: deny })).rejects.toBeInstanceOf(PermissionDeniedError)

      const otherRecipient = decide(operator, "session.message", to(s))
      await expect(registry.sendMessage(msg, { decision: otherRecipient })).rejects.toThrow(/not "/)

      const otherAction = decide(operator, "session.message.interrupt", to(p))
      await expect(registry.sendMessage(msg, { decision: otherAction })).rejects.toThrow(/not session.message/)

      const ok = decide(operator, "session.message", to(p))
      expect(() => assertDecisionAllows(ok, "session.message", p.id)).not.toThrow()
      const r = await registry.sendMessage(msg, { decision: ok })
      expect(r.delivered).toEqual({ via: "inbox" })
    } finally {
      registry.shutdown()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
