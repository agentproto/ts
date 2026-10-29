import { describe, it, expect } from "vitest"
import { parseIdentityManifest } from "../manifest/index.js"

// AIP-23 `work` is the AIP-54 ws:// ref of the node's WORK.md, the same form
// as the AIP-22 OFFICE `work` field.
function identitySource(work: string): string {
  return [
    "---",
    "schema: identity.workspace/v1",
    "name: acme-identity",
    "title: Acme identity",
    "description: Identity workspace used to exercise the work ref.",
    'version: "1.0.0"',
    `work: ${work}`,
    "---",
    "",
    "Body.",
    "",
  ].join("\n")
}

describe("parseIdentityManifest work ref", () => {
  it("accepts the AIP-54 WORK.md ref", () => {
    const { frontmatter } = parseIdentityManifest(identitySource("ws://workspaces/@acme/main-tracker/WORK.md"))
    expect(frontmatter.work).toBe("ws://workspaces/@acme/main-tracker/WORK.md")
  })

  it("refuses the legacy bare workspace slug", () => {
    expect(() => parseIdentityManifest(identitySource("ws://workspaces/main-tracker"))).toThrow(/work/)
  })

  it("refuses a ref that does not end in WORK.md", () => {
    expect(() => parseIdentityManifest(identitySource("ws://workspaces/@acme/main-tracker/PLAN.md"))).toThrow(/work/)
  })
})
