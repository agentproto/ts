import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuthProfile } from "@agentproto/auth"
import {
  addHarnessPreset,
  getDefaultHarnessPreset,
  getHarnessPreset,
  harnessPresetsPath,
  HarnessPresetValidationError,
  listHarnessPresets,
  loadHarnessPresets,
  removeHarnessPreset,
  setDefaultPreset,
  updateHarnessPreset,
  type HarnessPreset,
  type HarnessPresetValidationDeps,
} from "../harness-preset-store.js"

// harnessPresetsPath() resolves under os.homedir() → $HOME on POSIX, so a temp
// HOME fully isolates these tests (same isolation the auth profile-store and
// llm-endpoint-links tests use).
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-harness-presets-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

function profile(over: Partial<AuthProfile>): AuthProfile {
  return { id: "p", endpoint: "openrouter", method: "api-key", ...over }
}

/** A validation-deps stub backed by an in-memory profile map. */
function depsFor(profiles: AuthProfile[]): HarnessPresetValidationDeps {
  const byId = new Map(profiles.map(p => [p.id, p]))
  return { getProfile: async id => byId.get(id) }
}

function preset(over: Partial<HarnessPreset> = {}): HarnessPreset {
  return {
    id: "hm-cheap",
    harnessSlug: "hermes",
    name: "Cheap",
    profileRef: "openrouter-cheap",
    defaultModel: "z-ai/glm-5.2",
    isDefault: false,
    ...over,
  }
}

const okDeps = () => depsFor([profile({ id: "openrouter-cheap" })])

describe("harness-preset store", () => {
  it("starts empty when no file exists", async () => {
    await expect(listHarnessPresets()).resolves.toEqual([])
    await expect(getHarnessPreset("hm-cheap")).resolves.toBeUndefined()
    await expect(getDefaultHarnessPreset("hermes")).resolves.toBeUndefined()
  })

  it("add → get → list round-trips a preset", async () => {
    await addHarnessPreset(preset(), okDeps())
    await expect(getHarnessPreset("hm-cheap")).resolves.toMatchObject({
      id: "hm-cheap",
      harnessSlug: "hermes",
      profileRef: "openrouter-cheap",
      defaultModel: "z-ai/glm-5.2",
    })
    await expect(listHarnessPresets()).resolves.toHaveLength(1)
  })

  it("filters list by harness slug", async () => {
    await addHarnessPreset(preset({ id: "hm-a", harnessSlug: "hermes" }), okDeps())
    await addHarnessPreset(
      preset({ id: "cx-a", harnessSlug: "claude-code" }),
      okDeps(),
    )
    await expect(listHarnessPresets("hermes")).resolves.toHaveLength(1)
    await expect(listHarnessPresets("claude-code")).resolves.toHaveLength(1)
    expect((await listHarnessPresets("hermes"))[0]?.id).toBe("hm-a")
  })

  it("writes the file at mode 0600", async () => {
    await addHarnessPreset(preset(), okDeps())
    const info = await stat(harnessPresetsPath())
    expect(info.mode & 0o777).toBe(0o600)
  })

  it("rejects a profileRef that references no profile", async () => {
    await expect(
      addHarnessPreset(preset({ profileRef: "ghost" }), depsFor([])),
    ).rejects.toBeInstanceOf(HarnessPresetValidationError)
  })

  it("rejects a disabled profile", async () => {
    const deps = depsFor([profile({ id: "openrouter-cheap", disabled: true })])
    await expect(addHarnessPreset(preset(), deps)).rejects.toBeInstanceOf(
      HarnessPresetValidationError,
    )
  })

  it("rejects a defaultModel outside the profile's allowlist", async () => {
    const deps = depsFor([
      profile({ id: "openrouter-cheap", models: { mode: "allow", ids: ["z-ai/other"] } }),
    ])
    await expect(addHarnessPreset(preset(), deps)).rejects.toBeInstanceOf(
      HarnessPresetValidationError,
    )
  })

  it("accepts a defaultModel inside the profile's allowlist", async () => {
    const deps = depsFor([
      profile({ id: "openrouter-cheap", models: { mode: "allow", ids: ["z-ai/glm-5.2"] } }),
    ])
    await expect(addHarnessPreset(preset(), deps)).resolves.toMatchObject({ id: "hm-cheap" })
  })

  it("accepts any model when the profile has mode: all curation", async () => {
    const deps = depsFor([profile({ id: "openrouter-cheap", models: { mode: "all", ids: [] } })])
    await expect(addHarnessPreset(preset(), deps)).resolves.toMatchObject({ id: "hm-cheap" })
  })

  it("rejects an invalid id shape via the schema", async () => {
    await expect(addHarnessPreset(preset({ id: "Bad Id" }), okDeps())).rejects.toThrow()
  })

  it("enforces at most one default per harness on add", async () => {
    const deps = depsFor([profile({ id: "openrouter-cheap" })])
    await addHarnessPreset(preset({ id: "hm-a", isDefault: true }), deps)
    await addHarnessPreset(preset({ id: "hm-b", isDefault: true }), deps)
    const hermes = await listHarnessPresets("hermes")
    expect(hermes.filter(p => p.isDefault).map(p => p.id)).toEqual(["hm-b"])
    await expect(getDefaultHarnessPreset("hermes")).resolves.toMatchObject({ id: "hm-b" })
  })

  it("keeps defaults independent across harnesses", async () => {
    const deps = depsFor([profile({ id: "openrouter-cheap" })])
    await addHarnessPreset(preset({ id: "hm-a", harnessSlug: "hermes", isDefault: true }), deps)
    await addHarnessPreset(
      preset({ id: "cx-a", harnessSlug: "claude-code", isDefault: true }),
      deps,
    )
    await expect(getDefaultHarnessPreset("hermes")).resolves.toMatchObject({ id: "hm-a" })
    await expect(getDefaultHarnessPreset("claude-code")).resolves.toMatchObject({ id: "cx-a" })
  })

  it("setDefaultPreset promotes one and demotes the rest", async () => {
    const deps = depsFor([profile({ id: "openrouter-cheap" })])
    await addHarnessPreset(preset({ id: "hm-a", isDefault: true }), deps)
    await addHarnessPreset(preset({ id: "hm-b" }), deps)
    await setDefaultPreset("hermes", "hm-b")
    await expect(getDefaultHarnessPreset("hermes")).resolves.toMatchObject({ id: "hm-b" })
    expect((await getHarnessPreset("hm-a"))?.isDefault).toBe(false)
  })

  it("setDefaultPreset rejects an unknown id", async () => {
    await expect(setDefaultPreset("hermes", "ghost")).rejects.toBeInstanceOf(
      HarnessPresetValidationError,
    )
  })

  it("setDefaultPreset rejects a harness/preset mismatch", async () => {
    await addHarnessPreset(preset({ id: "hm-a", harnessSlug: "hermes" }), okDeps())
    await expect(setDefaultPreset("claude-code", "hm-a")).rejects.toBeInstanceOf(
      HarnessPresetValidationError,
    )
  })

  it("updateHarnessPreset patches an existing preset and re-validates", async () => {
    const deps = depsFor([
      profile({ id: "openrouter-cheap" }),
      profile({ id: "openrouter-fast", models: { mode: "allow", ids: ["z-ai/glm-5.2"] } }),
    ])
    await addHarnessPreset(preset(), deps)
    const updated = await updateHarnessPreset("hm-cheap", { name: "Renamed" }, deps)
    expect(updated?.name).toBe("Renamed")
    await expect(updateHarnessPreset("ghost", { name: "x" }, deps)).resolves.toBeUndefined()
  })

  it("remove is idempotent", async () => {
    await addHarnessPreset(preset(), okDeps())
    await expect(removeHarnessPreset("hm-cheap")).resolves.toBe(true)
    await expect(removeHarnessPreset("hm-cheap")).resolves.toBe(false)
  })

  it("treats a malformed file as empty", async () => {
    // A first add creates `~/.agentproto/`; then corrupt the file in place.
    await addHarnessPreset(preset(), okDeps())
    await writeFile(harnessPresetsPath(), "{ not json", "utf8")
    await expect(loadHarnessPresets()).resolves.toEqual({ version: 1, presets: [] })
  })
})
