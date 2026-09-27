import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CredentialStore, StoreRef, StoredCredential } from "@agentproto/auth"
import type { HarnessPreset } from "@agentproto/runtime"
import type { EndpointConfig } from "@agentproto/llm-endpoint"
import type { ImportedMcpsConfig } from "@agentproto/runtime/mcp-imports"
import type { AdapterInfo } from "../registry/resolve.js"
import {
  gatherSettingsBundle,
  gatherSealedSecrets,
  applySettingsBundle,
  sanitizeConfigForExport,
  readSettingsBundle,
  writeSettingsBundle,
  SETTINGS_BUNDLE_VERSION,
  type SettingsGatherDeps,
  type SettingsApplyDeps,
  type ExportedAuthProfile,
} from "../lib/settings-bundle.js"

// ── fixtures ────────────────────────────────────────────────────────────

function fakeAdapter(overrides: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    slug: "hermes",
    name: "Hermes",
    version: "1.2.3",
    description: "",
    protocol: "cli",
    streaming: true,
    packageName: "@agentproto/adapter-hermes",
    commands: [],
    models: [],
    modes: [],
    modelDetails: [],
    ...overrides,
  }
}

const SAMPLE_PROFILE: ExportedAuthProfile = { id: "work-openrouter", endpoint: "openrouter", method: "api-key" }
const SAMPLE_PRESET: HarnessPreset = {
  id: "hm-cheap",
  harnessSlug: "hermes",
  name: "Cheap",
  profileRef: "work-openrouter",
  defaultModel: "z-ai/glm-5.2",
  isDefault: true,
}
const SAMPLE_ENDPOINT: EndpointConfig = { id: "ollama", kind: "openai", baseUrl: "http://192.168.1.20:11434/v1" }

function fakeCredentialStore(seed: Record<string, StoredCredential> = {}): CredentialStore {
  const map = new Map(Object.entries(seed))
  return {
    async read(ref: StoreRef) {
      return map.get(ref.path)
    },
    async write(ref: StoreRef, cred: StoredCredential) {
      map.set(ref.path, cred)
    },
    async delete(ref: StoreRef) {
      map.delete(ref.path)
    },
  }
}

function fakeGatherDeps(overrides: Partial<SettingsGatherDeps> = {}): SettingsGatherDeps {
  return {
    listInstalledAdapters: async () => [fakeAdapter()],
    loadHarnessPresets: async () => ({ version: 1, presets: [SAMPLE_PRESET] }),
    listAuthProfiles: async () => [{ ...SAMPLE_PROFILE, credentialRef: "agentproto.auth.openrouter" }],
    getAuthProfile: async (id: string) =>
      id === SAMPLE_PROFILE.id ? { ...SAMPLE_PROFILE, credentialRef: "agentproto.auth.openrouter" } : undefined,
    readEndpointsFromDisk: () => ({ endpoints: [SAMPLE_ENDPOINT], errors: [], path: "/fake/llm-endpoints.json" }),
    loadImportedMcps: async () => ({
      version: 1,
      imports: [
        {
          id: "claude-code:project:/Users/jeremy/repo:chrome-devtools",
          alias: "chrome-devtools",
          addedAt: "2026-05-10T00:00:00.000Z",
          snapshot: {
            id: "claude-code:project:/Users/jeremy/repo:chrome-devtools",
            source: "claude-code",
            scope: "project:/Users/jeremy/repo",
            name: "chrome-devtools",
            type: "http",
            url: "https://mcp.example/chrome-devtools",
            headers: { Authorization: "Bearer sk-should-never-leave-this-machine" },
          },
        },
        {
          id: "workspace:workspace:repo:local-chrome",
          alias: "local-chrome",
          addedAt: "2026-05-10T00:00:00.000Z",
          snapshot: {
            id: "workspace:workspace:repo:local-chrome",
            source: "workspace",
            scope: "workspace:repo",
            name: "local-chrome",
            type: "stdio",
            command: "/Users/jeremy/.agentproto/chrome-mcp/node_modules/.bin/chrome-devtools-mcp",
            args: ["--profile", "/Users/jeremy/.agentproto/chrome-profile-guildebrowser"],
          },
        },
      ],
    }),
    loadConfig: async () =>
      ({
        daemon: { authToken: "super-secret-token", workspace: "/Users/jeremy/.agentproto/workspace" },
        remote: { host: "wss://guilde.work/api/v1/agentproto/tunnel" },
        profiles: { local: { tunnel: { token: "apt_local_secret_value" } } },
      }) as never,
    credentialStore: fakeCredentialStore({
      "agentproto.auth.openrouter": { value: "sk-or-real-secret", kind: "pat" },
    }),
    ...overrides,
  }
}

function fakeApplyDeps(overrides: Partial<SettingsApplyDeps> = {}): SettingsApplyDeps {
  const authProfiles = new Map<string, ExportedAuthProfile & { disabled?: boolean; credentialRef?: string }>()
  const harnessPresets = new Map<string, HarnessPreset>()
  const mcpImports: ImportedMcpsConfig = { version: 1, imports: [] }
  const endpoints: EndpointConfig[] = []
  let config: Record<string, unknown> = {}
  const store = fakeCredentialStore()

  return {
    listInstalledAdapters: async () => [fakeAdapter()],
    getHarnessPreset: async (id: string) => harnessPresets.get(id),
    addHarnessPreset: async (preset: HarnessPreset) => {
      const profile = authProfiles.get(preset.profileRef)
      if (!profile) throw new Error(`profileRef "${preset.profileRef}" references no existing auth profile.`)
      if (profile.disabled) throw new Error(`profileRef "${preset.profileRef}" is disabled`)
      harnessPresets.set(preset.id, preset)
      return preset
    },
    getAuthProfile: async (id: string) => authProfiles.get(id) as never,
    addAuthProfile: async (profile) => {
      authProfiles.set(profile.id, profile as never)
    },
    createAuthProfile: async (input) => {
      if (authProfiles.has(input.id)) throw new Error(`a profile with id "${input.id}" already exists`)
      const credentialRef = `agentproto.auth.${input.endpoint}`
      await store.write({ path: credentialRef }, { value: input.credential!, kind: "pat" })
      authProfiles.set(input.id, { id: input.id, endpoint: input.endpoint, method: input.method, credentialRef } as never)
      return { id: input.id, endpoint: input.endpoint, method: input.method, credentialRef }
    },
    listAuthProfiles: async () => [...authProfiles.values()] as never,
    credentialStore: store,
    loadImportedMcps: async () => structuredClone(mcpImports),
    saveImportedMcps: async (next) => {
      mcpImports.imports = structuredClone(next.imports)
    },
    readEndpointsFromDisk: () => ({ endpoints: [...endpoints], errors: [], path: "/fake/llm-endpoints.json" }),
    resolveEndpointsFilePath: () => "/fake/llm-endpoints.json",
    writeEndpointsFile: async (_path, next) => {
      endpoints.length = 0
      endpoints.push(...next)
    },
    loadConfig: async () => structuredClone(config) as never,
    saveConfig: async (next) => {
      config = structuredClone(next) as never
    },
    ...overrides,
  }
}

// ── sanitizeConfigForExport ──────────────────────────────────────────────

describe("sanitizeConfigForExport", () => {
  it("drops fields the runtime schema marks secret, reporting the path not the value", () => {
    const { config, skipped } = sanitizeConfigForExport({
      daemon: { authToken: "super-secret-token", port: 18791 },
    })
    expect(config).toEqual({ daemon: { port: 18791 } })
    expect(skipped).toEqual([{ path: "daemon.authToken", reason: "secret" }])
    expect(JSON.stringify(skipped)).not.toContain("super-secret-token")
  })

  it("drops absolute-path and loopback string values as machine-specific", () => {
    const { config, skipped } = sanitizeConfigForExport({
      daemon: { workspace: "/Users/jeremy/.agentproto/workspace" },
      dev: { previewUrl: "http://localhost:5173" },
      label: "my-laptop",
    })
    expect(config).toEqual({ daemon: {}, dev: {}, label: "my-laptop" })
    expect(skipped).toEqual(
      expect.arrayContaining([
        { path: "daemon.workspace", reason: "machine-specific" },
        { path: "dev.previewUrl", reason: "machine-specific" },
      ]),
    )
  })

  it("filters offending values out of arrays without dropping the whole key", () => {
    const { config } = sanitizeConfigForExport({
      daemon: { allowedOrigins: ["https://guilde.work", "http://localhost:3000"] },
    })
    expect(config).toEqual({ daemon: { allowedOrigins: ["https://guilde.work"] } })
  })

  // Regression: `profiles.<name>.tunnel.token` mirrors the top-level
  // `tunnel.token` shape (ProfileConfig in config.ts) but has no CONFIG_KEYS
  // entry of its own — a schema-path-only check misses it entirely. Caught
  // in review by running the real export against a real config.json.
  it("drops a per-profile tunnel token even though config-schema has no CONFIG_KEYS entry for it", () => {
    const { config, skipped } = sanitizeConfigForExport({
      profiles: {
        local: { tunnel: { host: "ws://localhost:3200/connect", token: "apt_local_secret_value" } },
        prod: { tunnel: { host: "wss://tunnel.guilde.work/connect", token: "apt_prod_secret_value" } },
      },
    })
    expect(JSON.stringify(config)).not.toContain("apt_local_secret_value")
    expect(JSON.stringify(config)).not.toContain("apt_prod_secret_value")
    expect(skipped).toEqual(
      expect.arrayContaining([
        { path: "profiles.local.tunnel.token", reason: "secret" },
        { path: "profiles.prod.tunnel.token", reason: "secret" },
      ]),
    )
  })

  it("drops any string value under a credential-shaped key name, even one config-schema doesn't declare", () => {
    const { config, skipped } = sanitizeConfigForExport({
      someFutureAdapter: { apiKey: "sk-not-yet-in-config-schema", displayName: "My Adapter" },
    })
    expect(config).toEqual({ someFutureAdapter: { displayName: "My Adapter" } })
    expect(skipped).toEqual([{ path: "someFutureAdapter.apiKey", reason: "secret" }])
  })
})

// ── gatherSettingsBundle ──────────────────────────────────────────────────

describe("gatherSettingsBundle", () => {
  it("collects every category with no secrets by default", async () => {
    const { bundle, warnings } = await gatherSettingsBundle({}, fakeGatherDeps())
    expect(warnings).toEqual([])
    expect(bundle.version).toBe(SETTINGS_BUNDLE_VERSION)
    expect(bundle.adapters).toEqual([{ slug: "hermes", version: "1.2.3", packageName: "@agentproto/adapter-hermes" }])
    expect(bundle.harnessPresets).toEqual([SAMPLE_PRESET])
    expect(bundle.authProfiles).toEqual([SAMPLE_PROFILE])
    // credentialRef must never leak into the exported profile metadata.
    expect(bundle.authProfiles[0]).not.toHaveProperty("credentialRef")
    expect(bundle.llmEndpoints).toEqual([SAMPLE_ENDPOINT])
    expect(bundle.secrets).toBeUndefined()
  })

  it("redacts MCP env/header VALUES to key names only", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    const mcp = bundle.mcpServers[0]!
    expect(mcp.snapshot.headerKeys).toEqual(["Authorization"])
    expect(JSON.stringify(bundle)).not.toContain("sk-should-never-leave-this-machine")
  })

  it("drops a stdio MCP's command/args when they embed an absolute local path", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    const mcp = bundle.mcpServers.find(m => m.alias === "local-chrome")!
    expect(mcp.snapshot.command).toBeUndefined()
    expect(mcp.snapshot.args).toBeUndefined()
    expect(mcp.snapshot.redacted).toEqual(["command", "args"])
    expect(JSON.stringify(bundle)).not.toContain("/Users/jeremy/.agentproto")
  })

  it("sanitizes config.json and reports what was skipped", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    expect(bundle.config).toEqual({
      daemon: {},
      remote: { host: "wss://guilde.work/api/v1/agentproto/tunnel" },
      profiles: { local: { tunnel: {} } },
    })
    expect(bundle.configSkipped).toEqual(
      expect.arrayContaining([
        { path: "daemon.authToken", reason: "secret" },
        { path: "daemon.workspace", reason: "machine-specific" },
        { path: "profiles.local.tunnel.token", reason: "secret" },
      ]),
    )
    expect(JSON.stringify(bundle)).not.toContain("super-secret-token")
    expect(JSON.stringify(bundle)).not.toContain("apt_local_secret_value")
  })

  it("throws when --include-secrets is requested without a passphrase", async () => {
    await expect(
      gatherSettingsBundle({ includeSecrets: ["work-openrouter"] }, fakeGatherDeps()),
    ).rejects.toThrow(/passphrase/)
  })

  it("seals the requested profile's secret and never embeds it in the clear", async () => {
    const { bundle, warnings } = await gatherSettingsBundle(
      { includeSecrets: ["work-openrouter"], passphrase: "correct horse battery staple" },
      fakeGatherDeps(),
    )
    expect(warnings).toEqual([])
    expect(bundle.secrets).toHaveLength(1)
    expect(bundle.secrets![0]!.profileId).toBe("work-openrouter")
    expect(JSON.stringify(bundle)).not.toContain("sk-or-real-secret")
  })

  it("reports a failure per unresolvable --include-secrets id instead of throwing", async () => {
    const { secrets, failed } = await gatherSealedSecrets(
      ["no-such-profile"],
      "a passphrase",
      fakeGatherDeps(),
    )
    expect(secrets).toEqual([])
    expect(failed).toEqual([{ profileId: "no-such-profile", reason: "no such auth profile" }])
  })
})

// ── applySettingsBundle ───────────────────────────────────────────────────

describe("applySettingsBundle", () => {
  it("dry-run reports the plan and writes nothing", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    const applyDeps = fakeApplyDeps()
    const report = await applySettingsBundle(bundle, { dryRun: true }, applyDeps)
    expect(report.dryRun).toBe(true)
    expect(report.authProfiles.added).toEqual(["work-openrouter"])
    // Nothing actually persisted during a dry run.
    expect(await applyDeps.getAuthProfile("work-openrouter")).toBeUndefined()
  })

  it("creates a disabled, secret-less profile stub when no secret is restored", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    const applyDeps = fakeApplyDeps()
    const report = await applySettingsBundle(bundle, {}, applyDeps)
    expect(report.authProfiles.added).toEqual(["work-openrouter"])
    expect(report.secretsRestored).toEqual([])
    const profile = await applyDeps.getAuthProfile("work-openrouter")
    expect(profile?.disabled).toBe(true)
    expect(profile).not.toHaveProperty("credentialRef")
  })

  it("skips an entry that already exists locally, in every category", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    const applyDeps = fakeApplyDeps()
    await applyDeps.addAuthProfile({ id: "work-openrouter", endpoint: "openrouter", method: "api-key", disabled: true })
    const report = await applySettingsBundle(bundle, {}, applyDeps)
    expect(report.authProfiles.skipped).toEqual([{ item: "work-openrouter", reason: "already exists locally" }])
    // The harness preset references that same (now pre-existing, still
    // disabled) profile — it must fail validation, not silently no-op.
    expect(report.harnessPresets.skipped).toEqual([
      { item: "hm-cheap", reason: expect.stringContaining("disabled") },
    ])
  })

  it("restores a sealed secret end-to-end when the passphrase is given", async () => {
    const { bundle } = await gatherSettingsBundle(
      { includeSecrets: ["work-openrouter"], passphrase: "a strong passphrase" },
      fakeGatherDeps(),
    )
    const applyDeps = fakeApplyDeps()
    const report = await applySettingsBundle(
      bundle,
      { unsealPassphrase: "a strong passphrase" },
      applyDeps,
    )
    expect(report.secretsRestored).toEqual(["work-openrouter"])
    const profile = await applyDeps.getAuthProfile("work-openrouter")
    expect(profile?.disabled).toBeUndefined()
    expect(profile?.credentialRef).toBeDefined()
    const stored = await applyDeps.credentialStore.read({ path: profile!.credentialRef! })
    expect(stored?.value).toBe("sk-or-real-secret")
    // And the restored preset now validates cleanly against the profile.
    expect(report.harnessPresets.added).toEqual(["hm-cheap"])
  })

  it("falls back to a disabled stub when the unseal passphrase is wrong", async () => {
    const { bundle } = await gatherSettingsBundle(
      { includeSecrets: ["work-openrouter"], passphrase: "the real passphrase" },
      fakeGatherDeps(),
    )
    const applyDeps = fakeApplyDeps()
    const report = await applySettingsBundle(
      bundle,
      { unsealPassphrase: "the wrong passphrase" },
      applyDeps,
    )
    expect(report.secretsRestored).toEqual([])
    expect(report.authProfiles.skipped).toEqual([
      { item: "work-openrouter", reason: expect.stringContaining("failed to restore sealed secret") },
    ])
  })

  it("reports bundled adapters that aren't installed locally, without installing anything", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    const applyDeps = fakeApplyDeps({ listInstalledAdapters: async () => [] })
    const report = await applySettingsBundle(bundle, {}, applyDeps)
    expect(report.missingAdapters).toEqual([
      { slug: "hermes", version: "1.2.3", packageName: "@agentproto/adapter-hermes" },
    ])
  })

  it("merges MCP imports with env/header placeholders, never overwriting an existing import", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    const applyDeps = fakeApplyDeps()
    await applySettingsBundle(bundle, {}, applyDeps)
    const stored = await applyDeps.loadImportedMcps()
    expect(stored.imports[0]?.snapshot.headers).toEqual({ Authorization: "" })
  })

  it("only fills config keys that are unset locally, never overwriting an existing value", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    const applyDeps = fakeApplyDeps()
    await applyDeps.saveConfig({ remote: { host: "wss://already-set.example" } } as never)
    const report = await applySettingsBundle(bundle, {}, applyDeps)
    expect(report.config.skipped).toEqual([{ item: "remote.host", reason: "already set locally" }])
    const finalConfig = await applyDeps.loadConfig()
    expect((finalConfig as never as { remote: { host: string } }).remote.host).toBe("wss://already-set.example")
  })

  it("rejects a bundle with an unsupported version", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    await expect(
      applySettingsBundle({ ...bundle, version: 2 as never }, {}, fakeApplyDeps()),
    ).rejects.toThrow(/unsupported bundle version/)
  })
})

// ── file round-trip ────────────────────────────────────────────────────────

describe("readSettingsBundle / writeSettingsBundle", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-settings-bundle-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("round-trips a bundle through disk", async () => {
    const { bundle } = await gatherSettingsBundle({}, fakeGatherDeps())
    const file = join(dir, "bundle.json")
    await writeSettingsBundle(file, bundle)
    const readBack = await readSettingsBundle(file)
    expect(readBack).toEqual(bundle)
  })

  it("rejects a file with no recognizable version field", async () => {
    const file = join(dir, "not-a-bundle.json")
    await writeFile(file, JSON.stringify({ foo: "bar" }))
    await expect(readSettingsBundle(file)).rejects.toThrow(/does not look like a settings bundle/)
  })
})
