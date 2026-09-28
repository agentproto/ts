import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deleteUserPreset,
  deriveRecentSpawnConfigs,
  getUserPreset,
  listUserPresets,
  saveUserPreset,
  touchUserPreset,
  userPresetsPath,
} from "../user-presets.js"
import type { SessionDescriptor } from "../sessions.js"

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-user-presets-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe("user preset store", () => {
  it("starts empty and writes a private, versioned file", async () => {
    await expect(listUserPresets()).resolves.toEqual([])

    await saveUserPreset({
      id: "fast-deepseek",
      label: "Fast DeepSeek",
      adapter: "hermes",
      model: "deepseek/deepseek-v4-pro",
      route: { gateway: "openrouter" },
      access: { profileRef: "openrouter-api" },
      posture: "bypass",
      effort: "high",
      contextProfile: "lean",
    })

    await expect(getUserPreset("fast-deepseek")).resolves.toMatchObject({
      adapter: "hermes",
      route: { gateway: "openrouter" },
      access: { profileRef: "openrouter-api" },
    })
    const raw = await readFile(userPresetsPath(), "utf8")
    expect(JSON.parse(raw)).toMatchObject({ version: 1 })
    expect((await stat(userPresetsPath())).mode & 0o777).toBe(0o600)
  })

  it("upserts by id and deletes only an existing preset", async () => {
    await saveUserPreset({ id: "fast", label: "Fast", effort: "low" })
    await saveUserPreset({ id: "fast", label: "Faster", effort: "high" })

    await expect(listUserPresets()).resolves.toEqual([
      { id: "fast", label: "Faster", effort: "high" },
    ])
    await expect(deleteUserPreset("fast")).resolves.toBe(true)
    await expect(deleteUserPreset("fast")).resolves.toBe(false)
  })

  it("rejects unsafe ids and malformed routes at the write boundary", async () => {
    await expect(saveUserPreset({ id: "Not safe", label: "Bad" })).rejects.toThrow()
    await expect(
      saveUserPreset({
        id: "bad-route",
        label: "Bad route",
        route: { gateway: "custom", baseUrl: "not a url" },
      }),
    ).rejects.toThrow()
  })
})

describe("touchUserPreset", () => {
  it("stamps lastUsedAt on a known preset and is a no-op for an unknown id", async () => {
    await saveUserPreset({ id: "fast", label: "Fast" })
    await expect(getUserPreset("fast")).resolves.not.toHaveProperty("lastUsedAt")

    await touchUserPreset("fast")
    const touched = await getUserPreset("fast")
    expect(touched?.lastUsedAt).toEqual(expect.any(String))
    expect(() => new Date(touched!.lastUsedAt!).toISOString()).not.toThrow()

    // Unknown id: no throw, nothing written.
    await expect(touchUserPreset("ghost")).resolves.toBeUndefined()
    await expect(listUserPresets()).resolves.toHaveLength(1)
  })

  it("saveUserPreset preserves the existing lastUsedAt across an edit that omits it", async () => {
    await saveUserPreset({ id: "fast", label: "Fast" })
    await touchUserPreset("fast")
    const stampedAt = (await getUserPreset("fast"))?.lastUsedAt

    await saveUserPreset({ id: "fast", label: "Faster" })
    const after = await getUserPreset("fast")
    expect(after?.label).toBe("Faster")
    expect(after?.lastUsedAt).toBe(stampedAt)
  })
})

describe("deriveRecentSpawnConfigs", () => {
  /** A minimal agent-cli row — override per case. Mirrors crash-reaper.test.ts's
   *  own `row()` fixture helper. */
  function row(over: Partial<SessionDescriptor> & { id: string }): SessionDescriptor {
    return {
      kind: "agent-cli",
      workspaceSlug: "default",
      command: "claude (agent)",
      pid: 4242,
      status: "running",
      startedAt: "2026-07-23T00:00:00Z",
      harness: "claude-code",
      model: "opus",
      cwd: "/tmp/repo",
      ...over,
    }
  }

  it("derives adapter/model/profileRef/cwd from harness/accessProfile, newest first", () => {
    const rows = [
      row({
        id: "a",
        harness: "hermes",
        model: "deepseek",
        cwd: "/tmp/a",
        accessProfile: { profileRef: "openrouter-cheap", endpoint: "openrouter", method: "api-key" },
      }),
    ]
    expect(deriveRecentSpawnConfigs(rows)).toEqual([
      {
        adapter: "hermes",
        model: "deepseek",
        profileRef: "openrouter-cheap",
        cwd: "/tmp/a",
        recent: true,
      },
    ])
  })

  it("falls back to adapterSlug when harness is unset, and skips a row with neither", () => {
    const rows = [
      row({ id: "a", harness: undefined, adapterSlug: "claude-code" }),
      row({ id: "b", harness: undefined, adapterSlug: undefined, cwd: "/tmp/b" }),
    ]
    const out = deriveRecentSpawnConfigs(rows)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ adapter: "claude-code" })
  })

  it("skips non-agent-cli sessions", () => {
    const rows: SessionDescriptor[] = [
      { ...row({ id: "a" }), kind: "terminal" },
      { ...row({ id: "b" }), kind: "command" },
    ]
    expect(deriveRecentSpawnConfigs(rows)).toEqual([])
  })

  it("de-duplicates identical (adapter, model, profileRef, cwd) tuples, keeping the most recent", () => {
    const rows = [
      row({ id: "a", harness: "hermes", model: "deepseek", cwd: "/tmp/x" }),
      row({ id: "b", harness: "hermes", model: "deepseek", cwd: "/tmp/x" }),
      row({ id: "c", harness: "hermes", model: "opus", cwd: "/tmp/x" }),
    ]
    const out = deriveRecentSpawnConfigs(rows)
    expect(out).toHaveLength(2)
    expect(out.map(c => c.model)).toEqual(["deepseek", "opus"])
  })

  it("caps at `limit` (default 5)", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      row({ id: `s${i}`, harness: "hermes", model: `model-${i}` }),
    )
    expect(deriveRecentSpawnConfigs(rows)).toHaveLength(5)
    expect(deriveRecentSpawnConfigs(rows, 2)).toHaveLength(2)
  })
})
