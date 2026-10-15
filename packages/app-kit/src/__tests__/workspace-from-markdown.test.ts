/**
 * `workspaceFromMarkdownText` — parse WORKSPACE.md text without touching
 * the filesystem (same manifest parse `loadAppHandle` runs on the file), so
 * a caller holding the text read out of a remote box gets the identical
 * validated workspace handle. Unparsable/invalid text → `undefined`.
 */

import { describe, it, expect } from "vitest"
import { workspaceFromMarkdownText } from "../load-app.js"

const VALID_FRONTMATTER = `---
schema: "workspace/v1"
id: "@acme/home"
version: "1.0.0"
name: Home
owner: { type: "org", id: "org_1", slug: acme }
storage:
  inline:
    provider: github
    config: { repo_url: "https://github.com/acme/pygmalion-home", mount_path: "/data/home" }
    sync: { mode: "pull-push", push: { branch_policy: "per-conversation", pr_policy: "manual" } }
---
body
`

describe("workspaceFromMarkdownText", () => {
  it("parses valid WORKSPACE.md text into a workspace handle", () => {
    const ws = workspaceFromMarkdownText(VALID_FRONTMATTER)
    expect(ws?.storage).toBeDefined()
    const inline = (
      ws as { storage?: { inline?: { provider?: unknown; config?: Record<string, unknown> } | null } }
    )?.storage?.inline
    expect(inline?.provider).toBe("github")
    expect(inline?.config?.["repo_url"]).toBe("https://github.com/acme/pygmalion-home")
  })

  it("returns undefined for text without valid frontmatter", () => {
    expect(workspaceFromMarkdownText("# no yaml at all\n")).toBeUndefined()
  })

  it("returns undefined for schema-invalid frontmatter", () => {
    expect(workspaceFromMarkdownText("---\nid: missing-everything\n---\n")).toBeUndefined()
  })
})
