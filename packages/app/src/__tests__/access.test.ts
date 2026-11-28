import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineApp, AppDefinitionError } from "../define-app.js"
import { loadAppHandle } from "../load-app.js"

const html = "<!doctype html><html><head></head><body>x</body></html>"

describe("access (remote opening)", () => {
  it("accepts remote true/false, is optional, and is frozen", () => {
    expect(defineApp({ id: "a/b", ui: { html } }).access).toBeUndefined()
    const off = defineApp({ id: "a/b", ui: { html }, access: { remote: false } })
    expect(off.access).toEqual({ remote: false })
    expect(Object.isFrozen(off.access)).toBe(true)
    expect(defineApp({ id: "a/b", ui: { html }, access: {} }).access).toEqual({})
  })

  it.each([
    ["unknown key", { nope: true }],
    ["non-boolean", { remote: "no" }],
    ["array", []],
  ])("refuses %s", (_n, access) => {
    expect(() => defineApp({ id: "a/b", ui: { html }, access: access as never })).toThrow(AppDefinitionError)
  })

  it("round-trips through emit and loadAppHandle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "access-"))
    try {
      await defineApp({ id: "a/b", ui: { html }, access: { remote: false } }).emit(dir)
      expect((await loadAppHandle(dir)).access).toEqual({ remote: false })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

})
