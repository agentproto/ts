import { describe, expect, it } from "vitest"

import type { WorkspacesConfig } from "../client/types.js"
import {
  buildPinStatusText,
  mapWorkspacePinQuickPickItems,
  resolvePinnedTarget,
} from "./workspacePin.logic.js"

const config: WorkspacesConfig = {
  version: 1,
  workspaces: [
    { slug: "studio", path: "/Code/studio", addedAt: "", updatedAt: "", label: "Agentik Studio" },
    { slug: "ts", path: "/Code/studio/projects/agentproto/ts", addedAt: "", updatedAt: "" },
  ],
}

const EMPTY: WorkspacesConfig = { version: 1, workspaces: [] }

describe("mapWorkspacePinQuickPickItems", () => {
  it("leads with an Auto row with no slug", () => {
    const items = mapWorkspacePinQuickPickItems(config)
    expect(items[0]?.slug).toBeUndefined()
    expect(items[0]?.label).toContain("Auto")
  })

  it("lists every registered workspace, labelled and pathed", () => {
    const items = mapWorkspacePinQuickPickItems(config)
    expect(items.slice(1)).toEqual([
      { label: "Agentik Studio", description: "/Code/studio", slug: "studio" },
      { label: "ts", description: "/Code/studio/projects/agentproto/ts", slug: "ts" },
    ])
  })

  it("is just the Auto row for an empty config", () => {
    expect(mapWorkspacePinQuickPickItems(EMPTY)).toHaveLength(1)
  })
})

describe("buildPinStatusText", () => {
  it("renders Auto for an unset pin", () => {
    expect(buildPinStatusText(config, undefined)).toBe("$(root-folder) Auto")
  })

  it("renders the workspace's label when pinned", () => {
    expect(buildPinStatusText(config, "studio")).toBe("$(root-folder) Agentik Studio")
  })

  it("falls back to the bare slug when the entry has no label", () => {
    expect(buildPinStatusText(config, "ts")).toBe("$(root-folder) ts")
  })

  it("falls back to the pinned slug itself when it no longer resolves", () => {
    expect(buildPinStatusText(config, "removed")).toBe("$(root-folder) removed")
  })
})

describe("resolvePinnedTarget", () => {
  it("is undefined for an unset pin", () => {
    expect(resolvePinnedTarget(config, undefined)).toBeUndefined()
  })

  it("resolves cwd/workspaceSlug from the registered entry", () => {
    expect(resolvePinnedTarget(config, "studio")).toEqual({
      cwd: "/Code/studio",
      workspaceSlug: "studio",
    })
  })

  it("is undefined when the pinned slug no longer resolves (workspace removed)", () => {
    expect(resolvePinnedTarget(config, "removed")).toBeUndefined()
  })
})
