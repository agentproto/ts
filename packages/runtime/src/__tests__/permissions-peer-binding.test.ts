/**
 * Verified workspace binding for peer messaging (shadow mode):
 * `defaults.messaging.peerBinding` "slug" (default) keeps today's rule and
 * only REPORTS `peerVerified`; "verified" requires both cwds to resolve to
 * the same registered workspace. The tree is never affected.
 */

import { describe, expect, it } from "vitest"

import { decide, type PermissionContext } from "../permissions.js"
import type { MessageTreeNode } from "../session-message.js"

const X: MessageTreeNode = { id: "X", workspaceSlug: "default", cwd: "/tmp/x" }
const Y: MessageTreeNode = { id: "Y", workspaceSlug: "default", cwd: "/tmp/y" }

const send = (a: MessageTreeNode, b: MessageTreeNode, ctx: PermissionContext) =>
  decide({ kind: "session", session: a }, "session.message", { kind: "session", session: b }, ctx)

describe("peer binding", () => {
  it("P1 slug mode allows same-slug peers and reports peerVerified=false", () => {
    const d = send(X, Y, { messaging: { peerBinding: "slug" }, workspaceOfCwd: () => undefined })
    expect(d.allow).toBe(true)
    expect(d.relation).toBe("peer")
    expect(d.peerVerified).toBe(false)
  })

  it("P1b the default mode is slug", () => {
    const d = send(X, Y, { workspaceOfCwd: () => undefined })
    expect(d.allow).toBe(true)
    expect(d.peerVerified).toBe(false)
  })

  it("P2 verified mode denies unverified same-slug peers", () => {
    const d = send(X, Y, { messaging: { peerBinding: "verified" }, workspaceOfCwd: () => undefined })
    expect(d.allow).toBe(false)
    expect(d.rule).toBe("messaging.peerBinding")
    expect(d.reason).toBe(
      "peers need a verified workspace binding (defaults.messaging.peerBinding: verified)",
    )
  })

  it("P3 verified mode allows peers whose cwds resolve to the same workspace", () => {
    const a: MessageTreeNode = { id: "A", workspaceSlug: "one", cwd: "/ws/a" }
    const b: MessageTreeNode = { id: "B", workspaceSlug: "two", cwd: "/ws/b" }
    const d = send(a, b, {
      messaging: { peerBinding: "verified" },
      workspaceOfCwd: cwd => (cwd === "/ws/a" || cwd === "/ws/b" ? "ws" : undefined),
    })
    expect(d.allow).toBe(true)
    expect(d.relation).toBe("peer")
    expect(d.peerVerified).toBe(true)
  })

  it("P3b verified mode applies to peer groups with the verified slugs", () => {
    const a: MessageTreeNode = { id: "A", workspaceSlug: "x", cwd: "/ws/a" }
    const b: MessageTreeNode = { id: "B", workspaceSlug: "y", cwd: "/ws/b" }
    const slugs: Record<string, string> = { "/ws/a": "g1", "/ws/b": "g2" }
    const ctx = (mode: "slug" | "verified"): PermissionContext => ({
      messaging: { peerBinding: mode, allowSameWorkspace: false, peerGroups: [["g1", "g2"]] },
      workspaceOfCwd: cwd => slugs[cwd],
    })
    expect(send(a, b, ctx("verified")).allow).toBe(true)
    expect(send(a, b, ctx("verified")).peerVerified).toBe(true)
    // slug mode: recorded slugs x/y are in no group, so no peer link.
    expect(send(a, b, ctx("slug")).allow).toBe(false)
  })

  it("P4 the tree is never affected by verified mode", () => {
    const parent: MessageTreeNode = { id: "P", workspaceSlug: "default", cwd: "/tmp/p" }
    const child: MessageTreeNode = { id: "C", parentSessionId: "P", workspaceSlug: "default", cwd: "/tmp/c" }
    const ctx: PermissionContext = { messaging: { peerBinding: "verified" }, workspaceOfCwd: () => undefined }
    const down = send(parent, child, ctx)
    const up = send(child, parent, ctx)
    expect(down.allow).toBe(true)
    expect(down.relation).toBe("parent")
    expect(down.peerVerified).toBeUndefined()
    expect(up.allow).toBe(true)
    expect(up.relation).toBe("child")
  })

})
