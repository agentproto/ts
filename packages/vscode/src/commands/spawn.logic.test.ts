import { describe, expect, it } from "vitest"

import type { WorkspacesConfig } from "../client/types.js"
import {
  assembleSpawnOptions,
  buildSpawnPlaceHolder,
  classifyProfileChoice,
  CONFIGURE_LABEL,
  CUSTOM_MODEL_LABEL,
  CUSTOM_MODEL_SECTION_LABEL,
  mapAdapterQuickPickItems,
  mapCatalogSpawnQuickPickItems,
  mapFolderQuickPickItems,
  mapModeQuickPickItems,
  mapModelQuickPickItems,
  mapOrchestratorQuickPickItems,
  mapPermissionQuickPickItems,
  mapPresetQuickPickItems,
  mapProviderQuickPickItems,
  mapSpawnQuickPickItems,
  modelEntriesOf,
  prependPresetGroup,
  resolveDefaultCwd,
  resolveWorkspaceSlug,
  type SpawnAdapterInfo,
  type WorkspaceFolderLike,
} from "./spawn.logic.js"
import type { CatalogModelsResponse, UserPreset } from "../client/types.js"

function adapter(overrides: Partial<SpawnAdapterInfo> = {}): SpawnAdapterInfo {
  return { slug: "claude-code", ...overrides }
}

function folder(name: string, fsPath: string): WorkspaceFolderLike {
  return { name, uri: { fsPath } }
}

function preset(overrides: Partial<UserPreset> = {}): UserPreset {
  return { id: "p1", label: "preset-1", ...overrides }
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

describe("mapPresetQuickPickItems", () => {
  it("maps preset label and adapter/model/harness to quick-pick items", () => {
    const presets = [
      preset({ id: "p1", label: "My Preset", adapter: "claude-code", model: "opus" }),
      preset({ id: "p2", label: "Alt Preset", harness: "hermes", model: "sonnet" }),
    ]
    const items = mapPresetQuickPickItems(presets)
    expect(items).toEqual([
      { label: "My Preset", description: "claude-code · opus", preset: presets[0] },
      { label: "Alt Preset", description: "hermes · sonnet", preset: presets[1] },
    ])
  })

  it("shows only adapter when no model is set", () => {
    const presets = [preset({ id: "p1", label: "Adapter Only", adapter: "claude-code" })]
    const items = mapPresetQuickPickItems(presets)
    expect(items[0]).toEqual({ label: "Adapter Only", description: "claude-code", preset: presets[0] })
  })

  it("shows only model when no adapter/harness is set", () => {
    const presets = [preset({ id: "p1", label: "Model Only", model: "opus" })]
    const items = mapPresetQuickPickItems(presets)
    expect(items[0]).toEqual({ label: "Model Only", description: "opus", preset: presets[0] })
  })

  it("uses harness when adapter is absent", () => {
    const presets = [preset({ id: "p1", label: "Harness Preset", harness: "hermes", model: "sonnet" })]
    const items = mapPresetQuickPickItems(presets)
    expect(items[0]?.description).toBe("hermes · sonnet")
  })

  it("sets description to undefined when preset has no adapter, harness, or model", () => {
    const presets = [preset({ id: "p1", label: "Empty Preset" })]
    const items = mapPresetQuickPickItems(presets)
    expect(items[0]).toEqual({ label: "Empty Preset", description: undefined, preset: presets[0] })
  })
})

describe("prependPresetGroup", () => {
  it("returns items unchanged when there are no presets", () => {
    const items = [{ label: "adapter-1", adapter: adapter() }]
    const result = prependPresetGroup(items, [])
    expect(result).toEqual(items)
  })

  it("prepends a separator and preset rows when presets are present", () => {
    const presets = [
      preset({ id: "p1", label: "Preset 1", adapter: "claude-code" }),
      preset({ id: "p2", label: "Preset 2", harness: "hermes" }),
    ]
    const items = [{ label: "adapter-1", adapter: adapter() }]
    const result = prependPresetGroup(items, presets)
    expect(result.length).toBe(4) // separator + 2 presets + 1 original
    expect(result[0]?.label).toBe("Presets")
    expect(result[0]?.kind).toBe(-1)
    expect(result[1]?.label).toBe("Preset 1")
    expect(result[1]?.preset).toEqual(presets[0])
    expect(result[2]?.label).toBe("Preset 2")
    expect(result[2]?.preset).toEqual(presets[1])
    expect(result[3]).toEqual(items[0])
  })

  it("correctly orders preset rows, separator first", () => {
    const presets = [preset({ id: "p1", label: "My Preset", adapter: "claude-code" })]
    const items = [
      { label: "adapter-1", adapter: adapter({ slug: "adapter-1" }) },
      { label: "adapter-2", adapter: adapter({ slug: "adapter-2" }) },
    ]
    const result = prependPresetGroup(items, presets)
    expect(result.map(i => i.label)).toEqual(["Presets", "My Preset", "adapter-1", "adapter-2"])
  })
})

describe("mapSpawnQuickPickItems", () => {
  it("groups a bare model list (no modelDetails) under the adapter's own name — never a fabricated 'unknown'", () => {
    const items = mapSpawnQuickPickItems([adapter({ slug: "claude-code", models: ["opus", "sonnet"] })])
    expect(items).toEqual([
      { label: "claude-code", kind: -1 },
      { label: "opus", description: "claude-code", adapter: items[1]!.adapter, model: "opus" },
      { label: "sonnet", description: "claude-code", adapter: items[2]!.adapter, model: "sonnet" },
      { label: CUSTOM_MODEL_SECTION_LABEL, kind: -1 },
      {
        label: `claude-code · ${CUSTOM_MODEL_LABEL}`,
        description: undefined,
        adapter: items[4]!.adapter,
        custom: true,
      },
      { label: CONFIGURE_LABEL, configure: true },
    ])
  })

  it("emits a bare adapter row with no custom row when no models are declared", () => {
    const items = mapSpawnQuickPickItems([adapter({ slug: "aider", hint: "needs setup" })])
    expect(items).toEqual([
      { label: "aider", kind: -1 },
      { label: "aider", description: "needs setup", adapter: items[1]!.adapter },
      { label: CONFIGURE_LABEL, configure: true },
    ])
  })

  it("orders adapters ready-first, always trailing with a single Configure… row", () => {
    const a = adapter({ slug: "a", status: "supported" })
    const b = adapter({ slug: "b", status: "ready", models: ["m1"] })
    const items = mapSpawnQuickPickItems([a, b])
    expect(items.map(i => i.label)).toEqual([
      "b",
      "m1",
      "a",
      "a",
      CUSTOM_MODEL_SECTION_LABEL,
      `b · ${CUSTOM_MODEL_LABEL}`,
      CONFIGURE_LABEL,
    ])
  })

  // Regression coverage for the operator-visible bug this PR fixes: the
  // collapsed picker used to flatten every model to a bare "slug · model"
  // row with no mode, so picking claude-sdk's kimi-k2.7-code silently
  // spawned in the adapter's default mode — native Anthropic — sending a
  // Moonshot model id to the wrong provider. A model whose manifest entry
  // binds a `mode` must carry that mode on its row so spawn.ts can apply
  // it; this covers the mapping half of the fix (spawn.ts's use of
  // `picked.mode` is the other half, wired but not independently unit
  // tested — see the file header on why only this pure-logic layer is).
  describe("provider grouping + mode binding (claude-sdk-shaped fixture)", () => {
    const claudeSdk = adapter({
      slug: "claude-sdk",
      status: "ready",
      modelDetails: [
        { id: "claude-sonnet-5", provider: "anthropic" },
        { id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" },
        { id: "z-ai/glm-5.2", provider: "openrouter", mode: "openrouter" },
      ],
    })

    it("groups rows under a provider heading — the provider is the heading, not a label prefix", () => {
      const items = mapSpawnQuickPickItems([claudeSdk])
      const headings = items.filter(i => i.kind !== undefined).map(i => i.label)
      expect(headings).toEqual(["anthropic", "moonshot", "openrouter", CUSTOM_MODEL_SECTION_LABEL])
    })

    it("picking the kimi-k2.7-code row carries its bound moonshot mode through to spawn options", () => {
      const items = mapSpawnQuickPickItems([claudeSdk])
      const kimiRow = items.find(i => i.model === "kimi-k2.7-code")
      expect(kimiRow).toBeDefined()
      expect(kimiRow?.label).toBe("kimi-k2.7-code")
      expect(kimiRow?.description).toBe("claude-sdk") // description carries the adapter now — label carries the model
      expect(kimiRow?.mode).toBe("moonshot")

      const options = assembleSpawnOptions({ adapter: "claude-sdk", model: kimiRow!.model!, mode: kimiRow!.mode })
      expect(options).toEqual({ adapter: "claude-sdk", model: "kimi-k2.7-code", mode: "moonshot" })
    })

    it("a native model with no bound mode carries none — never forces an unrelated mode switch", () => {
      const items = mapSpawnQuickPickItems([claudeSdk])
      const sonnetRow = items.find(i => i.model === "claude-sonnet-5")
      expect(sonnetRow?.mode).toBeUndefined()
    })
  })

  it("back-compat: a bare-string model list still lists every model, with no provider guessed", () => {
    const items = mapSpawnQuickPickItems([
      adapter({ slug: "codex", status: "ready", models: ["gpt-5-codex", "gpt-5"] }),
    ])
    const heading = items.find(i => i.kind !== undefined)
    expect(heading?.label).toBe("codex")
    const row = items.find(i => i.model === "gpt-5-codex")
    expect(row?.label).toBe("gpt-5-codex")
    expect(row?.description).toBe("codex")
    expect(row?.mode).toBeUndefined()
  })
})

describe("mapProviderQuickPickItems", () => {
  it("lists distinct providers in first-appearance order", () => {
    const items = mapProviderQuickPickItems(
      adapter({
        slug: "claude-sdk",
        modelDetails: [
          { id: "claude-sonnet-5", provider: "anthropic" },
          { id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" },
          { id: "claude-opus-4-8", provider: "anthropic" },
        ],
      }),
    )
    expect(items).toEqual([
      { label: "anthropic", provider: "anthropic" },
      { label: "moonshot", provider: "moonshot" },
    ])
  })

  it("groups an unstated-provider model under the adapter's own name, not a fabricated 'unknown'", () => {
    const items = mapProviderQuickPickItems(adapter({ slug: "codex", models: ["gpt-5-codex"] }))
    expect(items).toEqual([{ label: "codex", provider: undefined }])
  })

  it("returns an empty list when the adapter declares no models", () => {
    expect(mapProviderQuickPickItems(adapter({ slug: "aider" }))).toEqual([])
  })
})

describe("modelEntriesOf", () => {
  it("prefers the structured modelDetails projection when present", () => {
    const a = adapter({ modelDetails: [{ id: "x", provider: "p" }], models: ["x"] })
    expect(modelEntriesOf(a)).toEqual([{ id: "x", provider: "p" }])
  })

  it("falls back to the flat models list, provider left unstated — never guessed", () => {
    const a = adapter({ models: ["x", "y"] })
    expect(modelEntriesOf(a)).toEqual([{ id: "x" }, { id: "y" }])
  })

  it("is empty when the adapter declares neither", () => {
    expect(modelEntriesOf(adapter({}))).toEqual([])
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

  it("announces permission-hold up front — a session that stops at every tool must not be a surprise", () => {
    expect(buildSpawnPlaceHolder(workspaces, "/repo/app", true)).toBe(
      "Spawning in Agentik Studio (/repo/app) — select adapter · model · asking before each tool",
    )
    expect(buildSpawnPlaceHolder(workspaces, undefined, true)).toBe(
      "No workspace folder open — select adapter · model · asking before each tool (Configure… to set a working directory)",
    )
  })
})

describe("mapOrchestratorQuickPickItems", () => {
  it("defaults to standalone and says what orchestrating costs", () => {
    const items = mapOrchestratorQuickPickItems()
    expect(items.map(i => i.orchestrator)).toEqual([false, true])
    // Enter keeps today's behaviour: a plain session, no caps.
    expect(items[0]?.label).toBe("Standalone")
    // Choosing it is not free — it also brings depth/child caps and
    // subtree-only visibility. The row has to say so before you pick it.
    expect(items[1]?.description).toContain("nest under it")
    expect(items[1]?.description).toContain("caps")
  })
})

describe("mapPermissionQuickPickItems", () => {
  it("offers both modes and leads with the current default", () => {
    const unattended = mapPermissionQuickPickItems(false)
    expect(unattended.map(i => i.hold)).toEqual([false, true])
    expect(unattended[0]?.label).toBe("Unattended")

    // Leading with the current setting means Enter re-picks it rather than
    // silently flipping the user's default.
    const holding = mapPermissionQuickPickItems(true)
    expect(holding.map(i => i.hold)).toEqual([true, false])
    expect(holding[0]?.label).toBe("Ask me before each tool")
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

  it("sends orchestrator only when asked — the flag is what makes subagents nest at all", () => {
    // The tree nests children under their spawner and always has. It never had
    // anything to nest: parentSessionId comes from callerScope, callerScope
    // comes from the scoped gateway, and the gateway is minted only for an
    // orchestrator spawn. Without this the option was unreachable from the
    // editor and every subagent was recorded as a root.
    expect(assembleSpawnOptions({ adapter: "claude-code", orchestrator: true })).toEqual({
      adapter: "claude-code",
      orchestrator: true,
    })
    expect(assembleSpawnOptions({ adapter: "claude-code", orchestrator: false })).toEqual({
      adapter: "claude-code",
    })
  })

  it("sends permissionHold only when held — the flag is what makes the permission inbox fire at all", () => {
    // Without it the adapter auto-answers every request and GET /permissions
    // stays empty forever, so the whole approve/deny chain is dead code.
    expect(assembleSpawnOptions({ adapter: "claude-code", permissionHold: true })).toEqual({
      adapter: "claude-code",
      permissionHold: true,
    })
    // false is the daemon's own default — say nothing rather than assert it.
    expect(assembleSpawnOptions({ adapter: "claude-code", permissionHold: false })).toEqual({
      adapter: "claude-code",
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

  it("includes presetId when set", () => {
    expect(assembleSpawnOptions({ adapter: "claude-code", presetId: "preset-1" })).toEqual({
      adapter: "claude-code",
      presetId: "preset-1",
    })
  })

  it("omits presetId when unset", () => {
    expect(assembleSpawnOptions({ adapter: "claude-code" })).toEqual({
      adapter: "claude-code",
    })
    expect(assembleSpawnOptions({ adapter: "claude-code", presetId: undefined })).toEqual({
      adapter: "claude-code",
    })
  })

  it("can combine presetId with other fields", () => {
    expect(
      assembleSpawnOptions({
        adapter: "claude-code",
        presetId: "preset-1",
        model: "opus",
        cwd: "/tmp/work",
      }),
    ).toEqual({
      adapter: "claude-code",
      presetId: "preset-1",
      model: "opus",
      cwd: "/tmp/work",
    })
  })

  it("emits route + access when a gateway model resolved a wallet", () => {
    // The whole point of the catalog picker fix: a gateway model must carry
    // both its gateway and the profile that bills it, or the daemon 500s the
    // serviceability guard for spawning walletless.
    expect(
      assembleSpawnOptions({
        adapter: "claude-code",
        model: "anthropic/claude-fable-5",
        route: { gateway: "openrouter" },
        accessProfileRef: "openrouter-api",
      }),
    ).toEqual({
      adapter: "claude-code",
      model: "anthropic/claude-fable-5",
      route: { gateway: "openrouter" },
      access: { profileRef: "openrouter-api" },
    })
  })

  it("emits route without access when the daemon's default wallet handles it", () => {
    expect(
      assembleSpawnOptions({ adapter: "claude-code", model: "opus", route: { gateway: "anthropic" } }),
    ).toEqual({ adapter: "claude-code", model: "opus", route: { gateway: "anthropic" } })
  })
})

describe("classifyProfileChoice", () => {
  it("attaches the sole eligible profile silently", () => {
    expect(classifyProfileChoice(["openrouter-api"], true)).toEqual({
      kind: "attach",
      profileRef: "openrouter-api",
    })
  })

  it("asks when several profiles are eligible", () => {
    expect(classifyProfileChoice(["anthropic-sub", "max-agentik"], true)).toEqual({
      kind: "pick",
      options: ["anthropic-sub", "max-agentik"],
    })
  })

  it("defaults (no access) when none eligible but the route runs as-is", () => {
    // The Anthropic subscription path: runnable with no named profile — the
    // daemon resolves its own wallet, so attaching nothing is correct.
    expect(classifyProfileChoice([], true)).toEqual({ kind: "default" })
    expect(classifyProfileChoice(undefined, true)).toEqual({ kind: "default" })
  })

  it("routes to connect when none eligible and the route can't run", () => {
    expect(classifyProfileChoice([], false)).toEqual({ kind: "connect" })
    expect(classifyProfileChoice(undefined, undefined)).toEqual({ kind: "connect" })
  })
})

describe("mapCatalogSpawnQuickPickItems", () => {
  const catalog: CatalogModelsResponse = {
    vendors: [
      {
        vendor: "anthropic",
        products: [
          {
            product: "claude-fable-5",
            routes: [
              {
                route: "openrouter",
                ref: "anthropic/claude-fable-5",
                baseUrl: null,
                pricing: null,
                runnable: true,
                eligibleProfiles: ["openrouter-api"],
                adapterModes: ["openrouter"],
                adapters: ["claude-code"],
                curated: true,
              },
              {
                route: "anthropic",
                ref: "claude-fable-5",
                baseUrl: null,
                pricing: null,
                runnable: false,
                eligibleProfiles: [],
                adapterModes: [],
                adapters: ["claude-code"],
                curated: true,
              },
            ],
          },
        ],
      },
    ],
  }

  it("carries route, eligibleProfiles, and runnable onto each row", () => {
    const items = mapCatalogSpawnQuickPickItems(catalog)
    const runnableRow = items.find(i => i.model === "anthropic/claude-fable-5")
    expect(runnableRow).toMatchObject({
      route: "openrouter",
      eligibleProfiles: ["openrouter-api"],
      runnable: true,
    })
    const nonRunnableRow = items.find(i => i.model === "claude-fable-5")
    expect(nonRunnableRow).toMatchObject({ route: "anthropic", eligibleProfiles: [], runnable: false })
    // The non-runnable row still shows the gap rather than vanishing.
    expect(nonRunnableRow?.description).toContain("no profile")
  })
})
