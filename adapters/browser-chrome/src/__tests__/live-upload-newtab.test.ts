/**
 * chrome-live: uploadFileOwnedTarget (CDP DOM.setFileInputFiles onto an
 * `<input type=file>` — never a write through it), newTabOwnedTarget (a FRESH
 * tab in the agent window, never a reuse) and listOwnedTabs.
 */

import { afterEach, describe, expect, it } from "vitest"
import { isAbsolute, join, resolve } from "node:path"
import { tmpdir } from "node:os"
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

describe("chrome-live: uploadFileOwnedTarget", () => {
  it("attaches absolute paths to the file input through DOM.setFileInputFiles", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const nav = await instance.navigateOwnedTarget("https://example.test/apply")
    const relative = join("uploads", "cv.pdf")
    const result = await instance.uploadFileOwnedTarget({ selector: "input[type=file]", paths: [relative] })
    expect(result.targetId).toBe(nav.targetId)
    const set = f.commands.find((c) => c.method === "DOM.setFileInputFiles")
    expect(set).toBeDefined()
    const files = (set?.params?.files as string[]) ?? []
    expect(files).toHaveLength(1)
    expect(isAbsolute(files[0] as string)).toBe(true)
    expect(files[0]).toBe(resolve(relative))
    expect(f.filesAttached.get("input[type=file]")).toEqual(files)
    await instance.stop()
  })

  it("throws when the selector does not match an <input type=file>, and never reaches DOM.setFileInputFiles", async () => {
    const f = await fake({ fileInputMissing: true })
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/apply")
    await expect(
      instance.uploadFileOwnedTarget({ selector: "#not-a-file-input", paths: [join(tmpdir(), "x.pdf")] })
    ).rejects.toThrow(/no <input type=file> matches/)
    expect(f.commands.some((c) => c.method === "DOM.setFileInputFiles")).toBe(false)
    await instance.stop()
  })

  it("refuses a foreign tabId, same ownership guard as everywhere else", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/apply")
    await expect(
      instance.uploadFileOwnedTarget({ selector: "input[type=file]", paths: [join(tmpdir(), "x.pdf")] }, "user-tab-1")
    ).rejects.toThrow(/not owned/)
    await instance.stop()
  })
})

describe("chrome-live: newTabOwnedTarget", () => {
  it("opens a FRESH tab every call (never reusing an owned one) in the agent window", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const first = await instance.newTabOwnedTarget("https://example.test/one")
    const second = await instance.newTabOwnedTarget("https://example.test/two")
    expect(second.targetId).not.toBe(first.targetId)
    expect(second.url).toBe("https://example.test/two")
    expect(f.commands.filter((c) => c.method === "Target.createTarget")).toHaveLength(2)
    await instance.stop()
  })

  it("opens about:blank when no url is given", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const tab = await instance.newTabOwnedTarget()
    expect(tab.url).toBe("about:blank")
    await instance.stop()
  })
})

describe("chrome-live: listOwnedTabs", () => {
  it("lists the agent's own tabs with their agent window, never the user's tabs", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const a = await instance.newTabOwnedTarget("https://example.test/one")
    const b = await instance.newTabOwnedTarget("https://example.test/two")
    const tabs = await instance.listOwnedTabs()
    expect(tabs.map((t) => t.targetId).sort()).toEqual([a.targetId, b.targetId].sort())
    // One agent window holds both (the fake only opens a NEW window for the first tab).
    expect(new Set(tabs.map((t) => t.windowId)).size).toBe(1)
    expect(tabs.some((t) => t.windowId === undefined)).toBe(false)
    expect(tabs.every((t) => (t.url === "https://example.test/one" || t.url === "https://example.test/two"))).toBe(true)
    await instance.stop()
  })
})
