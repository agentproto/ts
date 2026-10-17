import { describe, it, expect } from "vitest"
import {
  parseWorkspaceManifest,
  workspaceFromManifest,
  writeWorkspaceManifest,
} from "../manifest/index.js"
import type { WorkspaceDefinition } from "../types.js"

function validDef(): WorkspaceDefinition {
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
    const md = writeWorkspaceManifest(validDef(), "## Description\n\nChatCommerce's project node.\n")
    expect(md).toContain("schema: workspace/v2")
    expect(md).toContain("id: '@jeremy/chatcommerce'")

    const manifest = parseWorkspaceManifest(md)
    expect(manifest.frontmatter.id).toBe("@jeremy/chatcommerce")
    expect(manifest.body.trim()).toBe("## Description\n\nChatCommerce's project node.".trim())

    const handle = workspaceFromManifest(manifest)
    expect(handle.id).toBe("@jeremy/chatcommerce")
    expect(handle.includes).toHaveLength(1)
    expect(handle.wall).toBe("isolated")
  })

  it("writeWorkspaceManifest rejects an invalid definition before touching disk format", () => {
    expect(() => writeWorkspaceManifest({ ...validDef(), id: "bad-id" })).toThrow(
      /defineWorkspace \(AIP-34\): invalid id/,
    )
  })

  it("writeWorkspaceManifest rejects a field-level schema violation", () => {
    expect(() => writeWorkspaceManifest({ ...validDef(), version: "not-semver" })).toThrow(
      /defineWorkspace \(AIP-34\): version/,
    )
  })

  it("parseWorkspaceManifest rejects frontmatter missing required fields", () => {
    const md = "---\nschema: workspace/v2\nid: \"@a/b\"\n---\nbody\n"
    expect(() => parseWorkspaceManifest(md)).toThrow(/parseWorkspaceManifest/)
  })

  it("parseWorkspaceManifest rejects empty frontmatter", () => {
    expect(() => parseWorkspaceManifest("no frontmatter here")).toThrow(/missing or empty frontmatter/)
  })

  it("parseWorkspaceManifest rejects a workspace/v1 schema literal", () => {
    const md = "---\nschema: workspace/v1\nid: \"@a/b\"\nversion: 1.0.0\nname: A\nowner: { type: user, id: a, slug: a }\nstorage: { inline: { provider: local-fs, config: {} } }\n---\n"
    expect(() => parseWorkspaceManifest(md)).toThrow(/parseWorkspaceManifest/)
  })
})
