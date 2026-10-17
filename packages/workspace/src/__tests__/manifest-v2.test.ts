import { describe, it, expect } from "vitest"
import {
  parseWorkspaceV2Manifest,
  workspaceV2FromManifest,
  writeWorkspaceV2Manifest,
} from "../manifest/v2.js"
import type { WorkspaceDefinitionV2 } from "../types-v2.js"

function validDef(): WorkspaceDefinitionV2 {
  return {
    schema: "workspace/v2",
    id: "@jeremy/chatcommerce",
    version: "1.0.0",
    name: "ChatCommerce",
    type: "project",
    wall: "isolated",
    owner: { type: "org", id: "agentik", slug: "jeremy" },
    storage: { inline: { provider: "local-fs", config: { mount_path: "/tmp/agentik/chatcommerce" } } },
    includes: [{ ref: "ws://workspaces/@jeremy/simone#docs/whatsapp-flows", mode: "read" }],
  }
}

describe("workspace/v2 manifest round-trip", () => {
  it("writes a definition to markdown and parses it back to the same handle", () => {
    const md = writeWorkspaceV2Manifest(validDef(), "## Description\n\nChatCommerce's project node.\n")
    expect(md).toContain("schema: workspace/v2")
    expect(md).toContain("id: '@jeremy/chatcommerce'")

    const manifest = parseWorkspaceV2Manifest(md)
    expect(manifest.frontmatter.id).toBe("@jeremy/chatcommerce")
    expect(manifest.body.trim()).toBe("## Description\n\nChatCommerce's project node.".trim())

    const handle = workspaceV2FromManifest(manifest)
    expect(handle.id).toBe("@jeremy/chatcommerce")
    expect(handle.includes).toHaveLength(1)
    expect(handle.wall).toBe("isolated")
  })

  it("writeWorkspaceV2Manifest rejects an invalid definition before touching disk format", () => {
    // The id-pattern gate runs before `validate()`, so it's createDoctype's
    // generic "(AIP-34)" prefix here, not the v2-specific one — same as v1.
    expect(() => writeWorkspaceV2Manifest({ ...validDef(), id: "bad-id" })).toThrow(
      /defineWorkspace \(AIP-34\): invalid id/,
    )
  })

  it("writeWorkspaceV2Manifest rejects a field-level schema violation", () => {
    expect(() => writeWorkspaceV2Manifest({ ...validDef(), version: "not-semver" })).toThrow(
      /defineWorkspace \(AIP-34 workspace\/v2\): version/,
    )
  })

  it("parseWorkspaceV2Manifest rejects frontmatter missing required fields", () => {
    const md = "---\nschema: workspace/v2\nid: \"@a/b\"\n---\nbody\n"
    expect(() => parseWorkspaceV2Manifest(md)).toThrow(/parseWorkspaceV2Manifest/)
  })

  it("parseWorkspaceV2Manifest rejects empty frontmatter", () => {
    expect(() => parseWorkspaceV2Manifest("no frontmatter here")).toThrow(/missing or empty frontmatter/)
  })
})
