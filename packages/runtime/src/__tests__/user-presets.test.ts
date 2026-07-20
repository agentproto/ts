import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deleteUserPreset,
  getUserPreset,
  listUserPresets,
  saveUserPreset,
  userPresetsPath,
} from "../user-presets.js"

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
