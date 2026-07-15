import { describe, expect, it } from "vitest"

import type { WorkspacesConfig } from "../client/types.js"
import {
  assembleSpawnOptions,
  buildSpawnPlaceHolder,
  CONFIGURE_LABEL,
  CUSTOM_MODEL_LABEL,
  mapAdapterQuickPickItems,
  mapFolderQuickPickItems,
  mapModeQuickPickItems,
  mapModelQuickPickItems,
  mapSpawnQuickPickItems,
  resolveDefaultCwd,
  resolveWorkspaceSlug,
  type SpawnAdapterInfo,
  type WorkspaceFolderLike,
} from "./spawn.logic.js"

function adapter(overrides: Partial<SpawnAdapterInfo> = {}): SpawnAdapterInfo {
  return { slug: "claude-code", ...overrides }
}

function folder(name: string, fsPath: string): WorkspaceFolderLike {
  return { name, uri: { fsPath } }
}

describe("mapAdapterQuickPickItems", () => {
  it("maps slug to label and hint/status to description", () => {
    const items = mapAdapterQuickPickItems([
      adapter({ slug: "aider", hint: "needs setup", status: "available" }),
    ])
    expect(items).toEqual([{ label: "aider", description: "needs setup", adapter: items[0]!.adapter }])
  })

  it("falls back to status, then name, when hint is absent", () => {
    const items = mapAdapterQuickPickItems([adapter({ slug: "hermes", status: "ready" })])
    expect(items[0]!.description).toBe("ready")
  })

  it("puts status:ready adapters first, preserving relative order otherwise", () => {
    const a = adapter({ slug: "a", status: "supported" })
    const b = adapter({ slug: "b", status: "ready" })
    const c = adapter({ slug: "c", status: "available" })
    const d = adapter({ slug: "d", status: "ready" })
    const items = mapAdapterQuickPickItems([a, b, c, d])
    expect(items.map(i => i.label)).toEqual(["b", "d", "a", "c"])
  })

  it("treats adapters with no status as non-ready", () => {
    const items = mapAdapterQuickPickItems([adapter({ slug: "no-status" }), adapter({ slug: "r", status: "ready" })])
    expect(items.map(i => i.label)).toEqual(["r", "no-status"])
  })
})

describe("mapModelQuickPickItems", () => {
  it("appends a trailing custom entry after the declared models", () => {
    const items = mapModelQuickPickItems(["opus", "sonnet"])
    expect(items).toEqual([{ label: "opus" }, { label: "sonnet" }, { label: CUSTOM_MODEL_LABEL, custom: true }])
  })

  it("still offers a custom entry when the adapter declares no models", () => {
    const items = mapModelQuickPickItems([])
    expect(items).toEqual([{ label: CUSTOM_MODEL_LABEL, custom: true }])
  })
})

describe("mapModeQuickPickItems", () => {
  it("maps declared modes to quick-pick items", () => {
    const items = mapModeQuickPickItems([
      { id: "lean", status: "noop", status_note: "measured no-op" },
      { id: "full" },
    ])
    expect(items).toEqual([
      { label: "lean", description: "measured no-op", mode: "lean" },
      { label: "full", description: undefined, mode: "full" },
    ])
  })

  it("returns an empty array when the adapter declares no modes", () => {
    expect(mapModeQuickPickItems(undefined)).toEqual([])
    expect(mapModeQuickPickItems([])).toEqual([])
  })
})

describe("mapSpawnQuickPickItems", () => {
  it("flattens declared models to 'slug · model' rows plus a trailing custom row", () => {
    const items = mapSpawnQuickPickItems([adapter({ slug: "claude-code", models: ["opus", "sonnet"] })])
    expect(items).toEqual([
      { label: "claude-code · opus", description: undefined, adapter: items[0]!.adapter, model: "opus" },
      { label: "claude-code · sonnet", description: undefined, adapter: items[0]!.adapter, model: "sonnet" },
      {
        label: `claude-code · ${CUSTOM_MODEL_LABEL}`,
        description: undefined,
        adapter: items[0]!.adapter,
        custom: true,
      },
      { label: CONFIGURE_LABEL, configure: true },
    ])
  })

  it("emits a bare adapter row with no custom row when no models are declared", () => {
    const items = mapSpawnQuickPickItems([adapter({ slug: "aider", hint: "needs setup" })])
    expect(items).toEqual([
      { label: "aider", description: "needs setup", adapter: items[0]!.adapter },
      { label: CONFIGURE_LABEL, configure: true },
    ])
  })

  it("orders adapters ready-first, always trailing with a single Configure… row", () => {
    const a = adapter({ slug: "a", status: "supported" })
    const b = adapter({ slug: "b", status: "ready", models: ["m1"] })
    const items = mapSpawnQuickPickItems([a, b])
    expect(items.map(i => i.label)).toEqual(["b · m1", `b · ${CUSTOM_MODEL_LABEL}`, "a", CONFIGURE_LABEL])
  })
})

describe("resolveDefaultCwd", () => {
  const solo = [folder("app", "/repo/app")]
  const multi = [folder("app", "/repo/app"), folder("infra", "/repo/infra")]

  it("resolves to the folder containing the active editor's file (longest-prefix match)", () => {
    const nested = [folder("repo", "/repo"), folder("app", "/repo/app")]
    expect(resolveDefaultCwd({ folders: nested, activeFilePath: "/repo/app/src/index.ts" })).toEqual({
      kind: "resolved",
      cwd: "/repo/app",
    })
  })

  it("does not match across a path-segment boundary — falls through to the sole-folder rule", () => {
    const folders = [folder("app", "/repo/app")]
    expect(resolveDefaultCwd({ folders, activeFilePath: "/repo/app-old/src/index.ts" })).toEqual({
      kind: "resolved",
      cwd: "/repo/app",
    })
  })

  it("resolves to the sole folder when there is exactly one and no matching active file", () => {
    expect(resolveDefaultCwd({ folders: solo })).toEqual({ kind: "resolved", cwd: "/repo/app" })
  })

  it("is ambiguous with multiple folders and no active editor inside any of them", () => {
    expect(resolveDefaultCwd({ folders: multi })).toEqual({ kind: "ambiguous", candidates: multi })
  })

  it("falls through to ambiguous when the active file is outside every folder — never the file's own directory", () => {
    expect(resolveDefaultCwd({ folders: multi, activeFilePath: "/tmp/scratch.ts" })).toEqual({
      kind: "ambiguous",
      candidates: multi,
    })
  })

  it("is none when there are no folders at all", () => {
    expect(resolveDefaultCwd({ folders: [] })).toEqual({ kind: "none" })
    expect(resolveDefaultCwd({ folders: [], activeFilePath: "/tmp/scratch.ts" })).toEqual({ kind: "none" })
  })
})

describe("mapFolderQuickPickItems", () => {
  it("maps folder name to label and fsPath to description", () => {
    const folders = [folder("app", "/repo/app")]
    expect(mapFolderQuickPickItems(folders)).toEqual([
      { label: "app", description: "/repo/app", folder: folders[0] },
    ])
  })
})

const workspaces: WorkspacesConfig = {
  version: 1,
  workspaces: [
    { slug: "studio", path: "/repo/app", addedAt: "", updatedAt: "", label: "Agentik Studio" },
    { slug: "infra", path: "/repo/infra", addedAt: "", updatedAt: "" },
  ],
}

describe("resolveWorkspaceSlug", () => {
  it("resolves a cwd to its registered workspace slug", () => {
    expect(resolveWorkspaceSlug(workspaces, "/repo/app/src")).toBe("studio")
  })

  it("returns undefined for an unregistered cwd", () => {
    expect(resolveWorkspaceSlug(workspaces, "/repo/other")).toBeUndefined()
  })

  it("returns undefined when cwd is undefined or empty", () => {
    expect(resolveWorkspaceSlug(workspaces, undefined)).toBeUndefined()
    expect(resolveWorkspaceSlug(workspaces, "")).toBeUndefined()
  })
})

describe("buildSpawnPlaceHolder", () => {
  it("shows the workspace label and cwd when the cwd matches a registered workspace", () => {
    expect(buildSpawnPlaceHolder(workspaces, "/repo/app")).toBe(
      "Spawning in Agentik Studio (/repo/app) — select adapter · model",
    )
  })

  it("falls back to the slug when the workspace has no label", () => {
    expect(buildSpawnPlaceHolder(workspaces, "/repo/infra")).toBe(
      "Spawning in infra (/repo/infra) — select adapter · model",
    )
  })

  it("shows the raw cwd when it matches no registered workspace", () => {
    expect(buildSpawnPlaceHolder(workspaces, "/repo/other")).toBe(
      "Spawning in /repo/other — select adapter · model",
    )
  })

  it("shows a no-workspace message when there is no cwd at all", () => {
    expect(buildSpawnPlaceHolder(workspaces, undefined)).toBe(
      "No workspace folder open — select adapter · model (Configure… to set a working directory)",
    )
    expect(buildSpawnPlaceHolder(workspaces, "")).toBe(
      "No workspace folder open — select adapter · model (Configure… to set a working directory)",
    )
  })
})

describe("assembleSpawnOptions", () => {
  it("always includes adapter, omits unset optional fields", () => {
    expect(assembleSpawnOptions({ adapter: "claude-code" })).toEqual({ adapter: "claude-code" })
  })

  it("includes every answered field", () => {
    expect(
      assembleSpawnOptions({
        adapter: "claude-code",
        model: "opus",
        mode: "full",
        cwd: "/tmp/work",
        workspaceSlug: "studio",
        label: "my-session",
        prompt: "hello",
      }),
    ).toEqual({
      adapter: "claude-code",
      model: "opus",
      mode: "full",
      cwd: "/tmp/work",
      workspaceSlug: "studio",
      label: "my-session",
      prompt: "hello",
    })
  })

  it("omits empty-string answers (treated as 'use default')", () => {
    expect(assembleSpawnOptions({ adapter: "claude-code", model: "", cwd: "" })).toEqual({
      adapter: "claude-code",
    })
  })

  it("omits workspaceSlug when unset", () => {
    expect(assembleSpawnOptions({ adapter: "claude-code", cwd: "/tmp/work" })).toEqual({
      adapter: "claude-code",
      cwd: "/tmp/work",
    })
  })
})
