import { afterEach, describe, expect, it } from "vitest"
import { createChromeLiveProvider } from "../index.js"
import { startFakeChrome, type FakeChrome } from "./live-fake-chrome.js"

const fakes: FakeChrome[] = []
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()))
})

async function fake(options?: Parameters<typeof startFakeChrome>[0]): Promise<FakeChrome> {
  const f = await startFakeChrome(options)
  fakes.push(f)
  return f
}

async function owned(options?: Parameters<typeof startFakeChrome>[0]) {
  const f = await fake(options)
  const instance = await createChromeLiveProvider({ port: f.port, env: {}, consentTimeoutMs: 2_000 }).launch({}, {})
  await instance.attach()
  return { f, instance }
}

describe("chrome-live: pressKeyOwnedTarget", () => {
  it("dispatches trusted keyDown/keyUp for Enter with the CDP key metadata", async () => {
    const { f, instance } = await owned()
    await instance.pressKeyOwnedTarget({ key: "Enter" })
    expect(f.keyEvents).toEqual([
      expect.objectContaining({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }),
      expect.objectContaining({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }),
    ])
    expect(f.violations).toEqual([])
    await instance.stop()
  })

  it("maps digits and punctuation to their canonical DOM code", async () => {
    const { f, instance } = await owned()
    await instance.pressKeyOwnedTarget({ key: "1" })
    await instance.pressKeyOwnedTarget({ key: "/" })
    expect(f.keyEvents).toEqual([
      expect.objectContaining({ type: "keyDown", key: "1", code: "Digit1" }),
      expect.objectContaining({ type: "keyUp", key: "1", code: "Digit1" }),
      expect.objectContaining({ type: "keyDown", key: "/", code: "Slash" }),
      expect.objectContaining({ type: "keyUp", key: "/", code: "Slash" }),
    ])
    await instance.stop()
  })

  it("supports navigation keys, repeats, modifiers and an optional focus selector", async () => {
    const { f, instance } = await owned()
    await instance.pressKeyOwnedTarget({ key: "ArrowDown", selector: "#list", count: 3, modifiers: ["Shift"] })
    expect(f.keyEvents).toHaveLength(6)
    expect(f.keyEvents.every((e) => e.code === "ArrowDown" && e.windowsVirtualKeyCode === 40 && e.modifiers === 8)).toBe(true)
    expect(f.commands.some((c) => c.method === "Runtime.evaluate" && String(c.params?.expression).includes("__chromeLiveFocus"))).toBe(true)
    await instance.stop()
  })

  it("rejects an unknown key name and a missing focus selector", async () => {
    const { instance } = await owned({ selectorMissing: true })
    await expect(instance.pressKeyOwnedTarget({ key: "Frobnicate" })).rejects.toThrow(/unsupported key/i)
    await expect(instance.pressKeyOwnedTarget({ key: "Enter", selector: "#missing" })).rejects.toThrow(/no element matches/)
    await instance.stop()
  })
})

describe("chrome-live: selectOptionOwnedTarget", () => {
  it("selects by value and returns the committed value/label/index", async () => {
    const { f, instance } = await owned({
      selectOptions: [{ value: "fr", label: "France" }, { value: "de", label: "Allemagne" }],
    })
    const result = await instance.selectOptionOwnedTarget({ selector: "#country", value: "de" })
    expect(result).toEqual({ targetId: expect.any(String), value: "de", label: "Allemagne", index: 1 })
    expect(f.commands.some((c) => c.method === "Runtime.evaluate" && String(c.params?.expression).includes("__chromeLiveSelect"))).toBe(true)
    await instance.stop()
  })

  it("selects by label and by index", async () => {
    const { instance } = await owned({
      selectOptions: [{ value: "fr", label: "France" }, { value: "de", label: "Allemagne" }],
    })
    await expect(instance.selectOptionOwnedTarget({ selector: "#country", label: "Allemagne" })).resolves.toMatchObject({
      value: "de",
      label: "Allemagne",
      index: 1,
    })
    await expect(instance.selectOptionOwnedTarget({ selector: "#country", index: 1 })).resolves.toMatchObject({ value: "de", index: 1 })
    await instance.stop()
  })

  it("requires exactly one of value/label/index", async () => {
    const { instance } = await owned()
    await expect(instance.selectOptionOwnedTarget({ selector: "#country" })).rejects.toThrow(/value, label or index/)
    await expect(instance.selectOptionOwnedTarget({ selector: "#country", value: "fr", label: "France" })).rejects.toThrow(/value, label or index/)
    await instance.stop()
  })

  it("reports the available options when the value is missing, and errors on an unknown selector", async () => {
    const { instance } = await owned({
      selectOptions: [{ value: "fr", label: "France" }],
    })
    await expect(instance.selectOptionOwnedTarget({ selector: "#country", value: "zz" })).rejects.toThrow(/no option matching.*fr/)
    await instance.stop()
    const missing = await owned({ selectorMissing: true })
    await expect(missing.instance.selectOptionOwnedTarget({ selector: "#country", value: "fr" })).rejects.toThrow(/no element matches/)
    await missing.instance.stop()
  })
})

describe("chrome-live: waitForOwnedTarget", () => {
  it("polls until the condition matches and returns the elapsed time", async () => {
    const { f, instance } = await owned({ waitMisses: 2 })
    const result = await instance.waitForOwnedTarget({ selector: "#ready", state: "visible", timeoutMs: 1_000, pollMs: 5 })
    expect(result).toMatchObject({ targetId: expect.any(String), state: "visible", matched: true })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(f.commands.filter((c) => c.method === "Runtime.evaluate" && String(c.params?.expression).includes("__chromeLiveWait")).length).toBe(3)
    await instance.stop()
  })

  it("times out with a helpful message naming the selector, state and elapsed time", async () => {
    const { instance } = await owned({ waitMisses: 1_000_000 })
    await expect(
      instance.waitForOwnedTarget({ selector: "#never", state: "visible", timeoutMs: 50, pollMs: 5 }),
    ).rejects.toThrow(/timed out after 50ms waiting for #never to become visible/)
    await instance.stop()
  })

  it("waits for page-wide text with no selector", async () => {
    const { f, instance } = await owned({ waitMisses: 2, pageText: "All systems ready" })
    const result = await instance.waitForOwnedTarget({ state: "text", text: "systems ready", timeoutMs: 1_000, pollMs: 5 })
    expect(result).toMatchObject({ targetId: expect.any(String), state: "text", matched: true })
    expect(f.commands.filter((c) => c.method === "Runtime.evaluate" && String(c.params?.expression).includes("__chromeLiveWait")).length).toBe(3)
    await instance.stop()
  })

  it("requires a selector unless it is waiting for text, and text requires the text itself", async () => {
    const { instance } = await owned()
    await expect(instance.waitForOwnedTarget({ state: "visible" })).rejects.toThrow(/selector/)
    await expect(instance.waitForOwnedTarget({ selector: "#x", state: "text" })).rejects.toThrow(/text/)
    await expect(instance.waitForOwnedTarget({ state: "text" })).rejects.toThrow(/text/)
    await instance.stop()
  })
})
