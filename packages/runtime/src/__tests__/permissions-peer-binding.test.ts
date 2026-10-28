/**
 * Verified workspace binding for peer messaging (shadow mode):
 * `defaults.messaging.peerBinding` "slug" (default) keeps today's rule and
 * only REPORTS `peerVerified`; "verified" requires both cwds to resolve to
 * the same registered workspace. The tree is never affected.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { decide, type PermissionContext } from "../permissions.js"
import { registerPermissionsTools } from "../permissions-tools.js"
import type { MessageTreeNode } from "../session-message.js"
import type { SessionsRegistry } from "../sessions.js"
import { resetPeerUnverifiedWarnings, warnPeerUnverified } from "../workspace-binding.js"

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

  it("P6 verified mode needs BOTH cwds to resolve", () => {
    const a: MessageTreeNode = { id: "A", workspaceSlug: "default", cwd: "/ws/a" }
    const b: MessageTreeNode = { id: "B", workspaceSlug: "default", cwd: "/elsewhere/b" }
    const workspaceOfCwd = (cwd: string) => (cwd.startsWith("/ws/") ? "ws" : undefined)
    const slug = send(a, b, { messaging: { peerBinding: "slug" }, workspaceOfCwd })
    expect(slug.allow).toBe(true)
    expect(slug.peerVerified).toBe(false)
    const verified = send(a, b, { messaging: { peerBinding: "verified" }, workspaceOfCwd })
    expect(verified.allow).toBe(false)
    expect(verified.rule).toBe("messaging.peerBinding")
  })

  it("P7 verified mode links by registered workspace even when the recorded slugs differ", () => {
    // Pinned on purpose: "verified" replaces the slug rule, it does not only narrow it,
    // and the shadow log (slug mode) does not report this direction.
    const a: MessageTreeNode = { id: "A", workspaceSlug: "one", cwd: "/ws/a" }
    const b: MessageTreeNode = { id: "B", workspaceSlug: "two", cwd: "/ws/b" }
    const workspaceOfCwd = (cwd: string) => (cwd.startsWith("/ws/") ? "ws" : undefined)
    const slug = send(a, b, { messaging: { peerBinding: "slug" }, workspaceOfCwd })
    expect(slug.allow).toBe(false)
    expect(slug.rule).toBe("tree.none")
    expect(slug.peerVerified).toBeUndefined()
    const verified = send(a, b, { messaging: { peerBinding: "verified" }, workspaceOfCwd })
    expect(verified.allow).toBe(true)
    expect(verified.relation).toBe("peer")
    expect(verified.peerVerified).toBe(true)
  })
})

describe("permissions_explain agrees with decide() under peerBinding", () => {
  type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>

  function explainer(
    nodes: Record<string, MessageTreeNode>,
    opts: { peerBinding?: "slug" | "verified"; workspaceOfCwd?: (cwd: string) => string | undefined },
  ): Handler {
    let handler: Handler | undefined
    const server = {
      tool: (name: string, _desc: string, _schema: unknown, h: Handler) => {
        if (name === "permissions_explain") handler = h
      },
    } as unknown as McpServer
    // Only `get` is read by permissions_explain.
    const registry = { get: (id: string) => nodes[id] } as unknown as SessionsRegistry
    registerPermissionsTools(server, { registry, allowSameWorkspace: true, ...opts })
    if (!handler) throw new Error("permissions_explain was not registered")
    return handler
  }

  const nodes: Record<string, MessageTreeNode> = {
    A: { id: "A", workspaceSlug: "default", cwd: "/ws/a" },
    B: { id: "B", workspaceSlug: "default", cwd: "/elsewhere/b" },
    C: { id: "C", workspaceSlug: "default", cwd: "/ws/c" },
  }
  const workspaceOfCwd = (cwd: string) => (cwd.startsWith("/ws/") ? "ws" : undefined)

  // A to B: one side unregistered (slug allows, verified denies).
  // A to C: both registered in the same workspace (both modes allow, only verified reports it verified).
  for (const mode of ["slug", "verified"] as const) {
    for (const [from, to] of [
      ["A", "B"],
      ["A", "C"],
    ] as const) {
      it(`${mode} ${from} to ${to}: same allow, rule and peerVerified as decide()`, async () => {
        const handler = explainer(nodes, { peerBinding: mode, workspaceOfCwd })
        const res = await handler({ action: "session.message", sessionId: to, asSessionId: from })
        const out = JSON.parse(res.content[0]!.text) as {
          decision: { allow: boolean; rule: string; peerVerified?: boolean }
        }
        const expected = send(nodes[from]!, nodes[to]!, {
          messaging: { allowSiblings: false, allowSameWorkspace: true, peerBinding: mode, agentInterrupt: "deny" },
          workspaceOfCwd,
        })
        expect(out.decision.allow).toBe(expected.allow)
        expect(out.decision.rule).toBe(expected.rule)
        expect(out.decision.peerVerified).toBe(expected.peerVerified)
        // The expectations really differ by mode, so a missing wire is caught.
        expect(expected.allow).toBe(to === "C" || mode === "slug")
        expect(expected.peerVerified).toBe(to === "C")
      })
    }
  }
})

describe("peer-unverified warning", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetPeerUnverifiedWarnings()
  })

  it("P9 writes one line per sender/recipient pair, in the documented format", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const info = { senderId: "X", recipientId: "Y", slug: "default", rule: "messaging.peer" }
    expect(warnPeerUnverified(info)).toBe(true)
    expect(warnPeerUnverified(info)).toBe(false)
    expect(warnPeerUnverified({ ...info, recipientId: "Z" })).toBe(true)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "[permissions] peer-unverified sender=X recipient=Y slug=default rule=messaging.peer",
    )
  })
})
