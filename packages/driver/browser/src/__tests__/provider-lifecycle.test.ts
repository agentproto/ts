import { describe, expect, it } from "vitest"
import {
  browserHealthSchema,
  browserInstanceInfoSchema,
  browserManifestSchema,
  createBrowserRegistry,
} from "../index.js"
import { makeFakeProvider } from "./fake-provider.js"

describe("fake provider round trip", () => {
  it("manifest -> launch -> attach -> stop, reporting wasAlreadyRunning on a second launch", async () => {
    const { provider, state } = makeFakeProvider({
      id: "fake",
      capabilities: { cdp: true, headless: true },
    })
    const registry = createBrowserRegistry([provider])

    // manifest
    const { launch: _launch, check: _check, ...manifest } = registry.require("fake")
    expect(browserManifestSchema.safeParse(manifest).success).toBe(true)

    // launch
    const first = await provider.launch({ label: "work" }, {})
    expect(first.wasAlreadyRunning).toBe(false)
    expect(browserInstanceInfoSchema.safeParse(first).success).toBe(true)
    expect(first.endpoints.cdp).toBe("ws://127.0.0.1:9222")
    expect(state.launches).toBe(1)

    // health, including the optional lifecycle fields
    const health = await first.health()
    expect(browserHealthSchema.parse(health).lifecycle?.browserState).toBe("running")
    expect(health.lifecycle?.lastRestartReason).toBeNull()

    // attach
    const driver = await first.attach()
    expect(driver.kind).toBe("fake")
    await driver.navigate({ url: "https://example.test/", waitUntil: "load" })
    expect(driver.target.url).toBe("https://example.test/")
    await expect(driver.listRequests()).resolves.toEqual([])

    // second launch, same label: reused, not respawned
    const second = await provider.launch({ label: "work" }, {})
    expect(second.wasAlreadyRunning).toBe(true)
    expect(second.id).toBe(first.id)
    expect(state.launches).toBe(1)

    // a different label is a different instance
    const other = await provider.launch({ label: "other" }, {})
    expect(other.wasAlreadyRunning).toBe(false)
    expect(state.launches).toBe(2)

    // stop
    await first.stop()
    expect((await first.health()).ok).toBe(false)
    await expect(first.attach()).rejects.toThrow(/stopped/)

    // after a stop, the same label launches fresh
    const third = await provider.launch({ label: "work" }, {})
    expect(third.wasAlreadyRunning).toBe(false)
    expect(state.launches).toBe(3)
  })

  it("health accepts null lifecycle fields as a server reports them before first launch", () => {
    const parsed = browserHealthSchema.parse({
      ok: true,
      lifecycle: {
        bootId: "b",
        startedAt: "2026-09-29T07:30:12.481Z",
        browserState: "idle",
        launchedAt: null,
        lastLaunchMs: null,
        lastRestartReason: null,
      },
    })
    expect(parsed.lifecycle?.browserState).toBe("idle")
    expect(browserHealthSchema.safeParse({ ok: true, lifecycle: { browserState: "exploded" } }).success).toBe(false)
    expect(browserHealthSchema.safeParse({ ok: true }).success).toBe(true)
  })
})
