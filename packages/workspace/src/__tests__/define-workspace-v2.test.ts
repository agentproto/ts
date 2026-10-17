import { describe, it, expect } from "vitest"
import { defineWorkspaceV2 } from "../define-workspace-v2.js"
import type { WorkspaceDefinitionV2 } from "../types-v2.js"

function validDef(): WorkspaceDefinitionV2 {
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

describe("defineWorkspaceV2 (AIP-34 workspace/v2)", () => {
  it("imports cleanly", () => {
    expect(typeof defineWorkspaceV2).toBe("function")
  })

  it("accepts a minimal v2 node and applies defaults", () => {
    const ws = defineWorkspaceV2(validDef())
    expect(ws.schema).toBe("workspace/v2")
    expect(ws.wall).toBe("isolated")
    expect(ws.status).toBe("active")
    expect(ws.includes).toEqual([])
    expect(ws.lock).toBe("agentproto.lock")
  })

  it("rejects a bare (unscoped) id", () => {
    expect(() => defineWorkspaceV2({ ...validDef(), id: "simone" })).toThrow(
      /defineWorkspace \(AIP-34\): invalid id/,
    )
  })

  it("requires `type`", () => {
    const { type, ...rest } = validDef()
    expect(() => defineWorkspaceV2(rest as WorkspaceDefinitionV2)).toThrow(/workspace\/v2.*type/)
  })

  it("rejects an unknown wall level", () => {
    expect(() =>
      defineWorkspaceV2({ ...validDef(), wall: "medium" as never }),
    ).toThrow(/workspace\/v2/)
  })

  it("rejects a v1 schema literal", () => {
    expect(() =>
      defineWorkspaceV2({ ...validDef(), schema: "workspace/v1" as never }),
    ).toThrow(/workspace\/v2/)
  })

  it("accepts a full tree node with includes/exports/apps/policy", () => {
    const ws = defineWorkspaceV2({
      ...validDef(),
      wall: "isolated",
      includes: [{ ref: "ws://workspaces/@jeremy/agentik#commun", mode: "read" }],
      exports: [{ path: "docs/whatsapp-flows", to: "@jeremy/chatcommerce", mode: "read" }],
      apps: [{ id: "@agentik/seo-crew", version: "^0.1.0", expose: ["agents", "tools"] }],
      policy: { limits: [{ kind: "budget-usd-per-month", value: 80 }] },
      secrets: { file: ".secrets/SECRETS.md" },
      code: { file: "CODE.md" },
      work: { file: "WORK.md" },
    })
    expect(ws.includes).toHaveLength(1)
    expect(ws.exports?.[0]?.to).toBe("@jeremy/chatcommerce")
    expect(ws.apps?.[0]?.attach).toBe("self")
    expect(ws.policy?.limits?.[0]?.value).toBe(80)
    expect(ws.work).toEqual({ file: "WORK.md" })
  })
})
