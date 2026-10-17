import { describe, it, expect } from "vitest"
import { defineWorkspace } from "../define-workspace.js"
import type { WorkspaceDefinition } from "../types.js"

function validDef(): WorkspaceDefinition {
  return {
    schema: "workspace/v2",
    id: "@jeremy/simone",
    version: "1.0.0",
    name: "Simone",
    type: "project",
    owner: { type: "org", id: "agentik", slug: "jeremy" },
    storage: { inline: { provider: "local-fs", config: {} } },
  }
}

describe("defineWorkspace (AIP-34 workspace/v2)", () => {
  it("imports cleanly", () => {
    expect(typeof defineWorkspace).toBe("function")
  })

  it("accepts a minimal node and applies defaults", () => {
    const ws = defineWorkspace(validDef())
    expect(ws.schema).toBe("workspace/v2")
    expect(ws.wall).toBe("isolated")
    expect(ws.status).toBe("active")
    expect(ws.includes).toEqual([])
    expect(ws.accepted_apps).toEqual([])
    expect(ws.lock).toBe("agentproto.lock")
  })

  it("rejects a bare (unscoped) id", () => {
    expect(() => defineWorkspace({ ...validDef(), id: "simone" })).toThrow(
      /defineWorkspace \(AIP-34\): invalid id/,
    )
  })

  it("requires `type`", () => {
    const { type, ...rest } = validDef()
    expect(() => defineWorkspace(rest as WorkspaceDefinition)).toThrow(/defineWorkspace \(AIP-34\).*type/)
  })

  it("rejects an unknown wall level", () => {
    expect(() =>
      defineWorkspace({ ...validDef(), wall: "medium" as never }),
    ).toThrow(/defineWorkspace \(AIP-34\)/)
  })

  it("rejects a bare workspace/v1 schema literal — v1 is not a valid AIP-34 schema anymore", () => {
    expect(() =>
      defineWorkspace({ ...validDef(), schema: "workspace/v1" as never }),
    ).toThrow(/defineWorkspace \(AIP-34\)/)
  })

  it("accepts a full tree node with includes/exports/apps/accepted_apps/policy", () => {
    const ws = defineWorkspace({
      ...validDef(),
      wall: "isolated",
      includes: [{ ref: "ws://workspaces/@jeremy/agentik#commun", mode: "read" }],
      exports: [{ path: "docs/whatsapp-flows", to: "@jeremy/chatcommerce", mode: "read" }],
      apps: [{ id: "@agentik/seo-crew", version: "^0.1.0", expose: ["agents", "tools"] }],
      accepted_apps: [{ from: "@jeremy/other", app: "@agentik/seo-crew" }],
      policy: { limits: [{ kind: "budget-usd-per-month", value: 80 }] },
      secrets: { file: ".secrets/SECRETS.md" },
      code: { file: "CODE.md" },
      work: { file: "WORK.md" },
    })
    expect(ws.includes).toHaveLength(1)
    expect(ws.exports?.[0]?.to).toBe("@jeremy/chatcommerce")
    expect(ws.apps?.[0]?.attach).toBe("self")
    expect(ws.accepted_apps?.[0]?.from).toBe("@jeremy/other")
    expect(ws.policy?.limits?.[0]?.value).toBe(80)
    expect(ws.work).toEqual({ file: "WORK.md" })
  })

  it("rejects a path that escapes the tree via '..' traversal", () => {
    expect(() => defineWorkspace({ ...validDef(), secrets: { file: "../../etc/passwd" } })).toThrow(
      /defineWorkspace \(AIP-34\)/,
    )
  })

  it("rejects an absolute path", () => {
    expect(() => defineWorkspace({ ...validDef(), secrets: { file: "/etc/passwd" } })).toThrow(
      /defineWorkspace \(AIP-34\)/,
    )
  })
})
