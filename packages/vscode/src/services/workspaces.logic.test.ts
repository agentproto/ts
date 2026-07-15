import { describe, expect, it } from "vitest"

import type { WorkspacesConfig } from "../client/types.js"
import {
  findWorkspaceByPath,
  workspaceLabel,
  workspaceLabelFor,
  workspaceLabelsIn,
} from "./workspaces.logic.js"

const config: WorkspacesConfig = {
  version: 1,
  active: "studio",
  workspaces: [
    { slug: "studio", path: "/Code/studio", addedAt: "", updatedAt: "", label: "Agentik Studio" },
    { slug: "ts", path: "/Code/studio/projects/agentproto/ts", addedAt: "", updatedAt: "" },
    { slug: "trailing", path: "/Code/trailing/", addedAt: "", updatedAt: "" },
  ],
}

describe("findWorkspaceByPath", () => {
  it("matches the workspace root itself", () => {
    expect(findWorkspaceByPath(config, "/Code/studio")?.slug).toBe("studio")
  })

  it("matches a nested path", () => {
    expect(findWorkspaceByPath(config, "/Code/studio/packages/ui")?.slug).toBe("studio")
  })

  it("prefers the most specific (longest) registered path", () => {
    expect(findWorkspaceByPath(config, "/Code/studio/projects/agentproto/ts/packages/vscode")?.slug)
      .toBe("ts")
  })

  it("does not match across a segment boundary", () => {
    // "/Code/studio-old" must NOT match workspace "/Code/studio".
    expect(findWorkspaceByPath(config, "/Code/studio-old/src")).toBeUndefined()
  })

  it("normalizes trailing slashes on both sides", () => {
    expect(findWorkspaceByPath(config, "/Code/trailing")?.slug).toBe("trailing")
    expect(findWorkspaceByPath(config, "/Code/studio/")?.slug).toBe("studio")
  })

  it("returns undefined for an unregistered path and for an empty dir", () => {
    expect(findWorkspaceByPath(config, "/tmp/scratch")).toBeUndefined()
    expect(findWorkspaceByPath(config, "")).toBeUndefined()
  })
})

describe("workspaceLabel", () => {
  it("prefers the entry label, falls back to the slug", () => {
    expect(workspaceLabel(config, "studio")).toBe("Agentik Studio")
    expect(workspaceLabel(config, "ts")).toBe("ts")
  })

  it("passes an unknown slug straight through", () => {
    expect(workspaceLabel(config, "ghost")).toBe("ghost")
  })
})

describe("workspaceLabelFor", () => {
  it("resolves via cwd in preference to the descriptor slug", () => {
    // The bug this exists for: a terminal session's slug is "default" even
    // though its cwd sits inside a registered workspace.
    expect(workspaceLabelFor(config, { cwd: "/Code/studio/apps/web", workspaceSlug: "default" }))
      .toBe("Agentik Studio")
  })

  it("falls back to the slug when cwd matches nothing registered", () => {
    expect(workspaceLabelFor(config, { cwd: "/tmp/x", workspaceSlug: "studio" }))
      .toBe("Agentik Studio")
  })

  it("omits an unattributed default rather than rendering noise", () => {
    expect(workspaceLabelFor(config, { cwd: "/tmp/x", workspaceSlug: "default" })).toBeUndefined()
  })

  it("still renders `default` when there is no cwd to contradict it", () => {
    expect(workspaceLabelFor(config, { workspaceSlug: "default" })).toBe("default")
  })

  it("returns undefined when the session has no workspace at all", () => {
    expect(workspaceLabelFor(config, { workspaceSlug: "" })).toBeUndefined()
  })
})

describe("workspaceLabelsIn", () => {
  it("collects distinct labels, sorted, skipping unresolvable sessions", () => {
    const sessions = [
      { cwd: "/Code/studio", workspaceSlug: "studio" },
      { cwd: "/Code/studio/projects/agentproto/ts", workspaceSlug: "default" },
      { cwd: "/Code/studio/apps/web", workspaceSlug: "studio" },
      { cwd: "/tmp/x", workspaceSlug: "default" },
    ]
    expect(workspaceLabelsIn(config, sessions)).toEqual(["Agentik Studio", "ts"])
  })
})
