import { describe, expect, it } from "vitest"

import {
  assembleSpawnOptions,
  CUSTOM_MODEL_LABEL,
  mapAdapterQuickPickItems,
  mapModeQuickPickItems,
  mapModelQuickPickItems,
  type SpawnAdapterInfo,
} from "./spawn.logic.js"

function adapter(overrides: Partial<SpawnAdapterInfo> = {}): SpawnAdapterInfo {
  return { slug: "claude-code", ...overrides }
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
        label: "my-session",
        prompt: "hello",
      }),
    ).toEqual({
      adapter: "claude-code",
      model: "opus",
      mode: "full",
      cwd: "/tmp/work",
      label: "my-session",
      prompt: "hello",
    })
  })

  it("omits empty-string answers (treated as 'use default')", () => {
    expect(assembleSpawnOptions({ adapter: "claude-code", model: "", cwd: "" })).toEqual({
      adapter: "claude-code",
    })
  })
})
