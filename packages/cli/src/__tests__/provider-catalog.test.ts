import { mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Pin homedir to a throwaway dir so the cache writes nowhere near a real ~.
let FAKE_HOME = ""
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => FAKE_HOME }
})

import {
  catalogCachePath,
  hasProviderCatalog,
  loadCachedCatalogVoices,
  refreshProviderCatalog,
} from "../provider-catalog.js"

const ELEVENLABS_RESPONSE = {
  voices: [
    {
      voice_id: "O31r762Gb3WFygrEOGh0",
      name: "Victoire",
      labels: { gender: "female", accent: "french" },
      description: "FR voice",
      preview_url: "https://example.com/v.mp3",
    },
    {
      voice_id: "custom-clone-1",
      name: "My Clone",
      labels: { gender: "male" },
      description: null,
      preview_url: null,
    },
  ],
}

function stubFetch(json: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 401,
      statusText: ok ? "OK" : "Unauthorized",
      json: async () => json,
    })) as unknown as typeof fetch,
  )
}

beforeEach(() => {
  FAKE_HOME = mkdtempSync(join(tmpdir(), "agp-catalog-"))
})

afterEach(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe("hasProviderCatalog", () => {
  it("recognizes voice providers, rejects others", () => {
    expect(hasProviderCatalog("elevenlabs")).toBe(true)
    expect(hasProviderCatalog("minimax")).toBe(true)
    expect(hasProviderCatalog("anthropic")).toBe(false)
  })
})

describe("refreshProviderCatalog", () => {
  it("returns null for a provider with no live catalog", async () => {
    expect(await refreshProviderCatalog("anthropic", "k")).toBeNull()
  })

  it("fetches, maps, and writes the cache file", async () => {
    stubFetch(ELEVENLABS_RESPONSE)
    const result = await refreshProviderCatalog("elevenlabs", "xi-key")
    expect(result).toMatchObject({
      id: "voice-elevenlabs",
      count: 2,
      skipped: false,
    })
    const file = JSON.parse(
      await readFile(catalogCachePath("voice-elevenlabs"), "utf8"),
    )
    expect(file.provider).toBe("elevenlabs")
    expect(file.kind).toBe("voice")
    expect(file.sourceSha).toMatch(/^[0-9a-f]{64}$/)
    expect(file.voices.map((v: { catalogId: string }) => v.catalogId)).toEqual([
      "elevenlabs-victoire",
      "elevenlabs-my-clone",
    ])
  })

  it("smart-skips a re-fetch when the response is unchanged", async () => {
    stubFetch(ELEVENLABS_RESPONSE)
    await refreshProviderCatalog("elevenlabs", "xi-key")
    const second = await refreshProviderCatalog("elevenlabs", "xi-key")
    expect(second).toMatchObject({ skipped: true, count: 2 })
  })

  it("throws on a non-ok response (bad key)", async () => {
    stubFetch({}, false)
    await expect(refreshProviderCatalog("elevenlabs", "bad")).rejects.toThrow(
      /401/,
    )
  })
})

describe("loadCachedCatalogVoices", () => {
  it("returns [] when no cache dir exists", async () => {
    expect(await loadCachedCatalogVoices()).toEqual([])
  })

  it("folds cached voices for the boot overlay", async () => {
    stubFetch(ELEVENLABS_RESPONSE)
    await refreshProviderCatalog("elevenlabs", "xi-key")
    const voices = await loadCachedCatalogVoices()
    expect(voices).toHaveLength(2)
    expect(voices.every(v => v.provider === "elevenlabs")).toBe(true)
  })
})
