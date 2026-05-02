import { describe, it, expect } from "vitest"
import {
  createDoctype,
  DOCTYPE_DEFAULT_ID_PATTERN,
  DOCTYPE_MAX_DESCRIPTION_LEN,
} from "../index.js"

interface FakeDef {
  id: string
  description: string
  meta?: Record<string, unknown>
}

interface FakeHandle {
  readonly id: string
  readonly description: string
  readonly meta: Record<string, unknown>
}

const defineFake = createDoctype<FakeDef, FakeHandle>({
  aip: 999,
  name: "fake",
  build: (def) => ({
    id: def.id,
    description: def.description,
    meta: Object.freeze({ ...(def.meta ?? {}) }),
  }),
})

describe("createDoctype", () => {
  it("returns a frozen handle with build defaults applied", () => {
    const handle = defineFake({ id: "ok", description: "fine" })
    expect(handle.id).toBe("ok")
    expect(handle.description).toBe("fine")
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("rejects ids that do not match the default pattern", () => {
    expect(() =>
      defineFake({ id: "Has Caps", description: "x" }),
    ).toThrow(/invalid id 'Has Caps'/)
    expect(() =>
      defineFake({ id: "0", description: "x" }),
    ).toThrow(/invalid id '0'/) // too short (1 char)
  })

  it("includes the AIP tag and doctype name in error messages", () => {
    expect(() => defineFake({ id: "_bad", description: "x" })).toThrow(
      /defineFake \(AIP-999\): invalid id '_bad'/,
    )
  })

  it("rejects empty and oversized descriptions", () => {
    expect(() => defineFake({ id: "ok", description: "" })).toThrow(
      /description must be 1–2000 chars/,
    )
    expect(() =>
      defineFake({ id: "ok", description: "x".repeat(2001) }),
    ).toThrow(/description must be 1–2000 chars/)
  })

  it("runs spec-specific validate AFTER id+description checks", () => {
    const order: string[] = []
    const defineWithValidator = createDoctype<FakeDef, FakeHandle>({
      aip: 100,
      name: "validated",
      validate(def) {
        order.push("validate")
        if (def.meta?.forbidden) throw new Error("custom: forbidden")
      },
      build: (def) => {
        order.push("build")
        return { id: def.id, description: def.description, meta: {} }
      },
    })

    // id check happens first — validate doesn't run.
    expect(() => defineWithValidator({ id: "BAD", description: "x" })).toThrow(
      /invalid id/,
    )
    expect(order).toEqual([])

    // description check second.
    expect(() => defineWithValidator({ id: "ok", description: "" })).toThrow(
      /description must be 1–2000 chars/,
    )
    expect(order).toEqual([])

    // valid def — validate runs, then build.
    defineWithValidator({ id: "ok", description: "fine" })
    expect(order).toEqual(["validate", "build"])

    // custom validate failure surfaces unchanged.
    expect(() =>
      defineWithValidator({
        id: "ok",
        description: "fine",
        meta: { forbidden: true },
      }),
    ).toThrow(/custom: forbidden/)
  })

  it("respects a custom idPattern when provided", () => {
    const defineUuid = createDoctype<FakeDef, FakeHandle>({
      aip: 27,
      name: "ref",
      idPattern: /^[0-9a-f]{8}$/,
      build: (def) => ({ id: def.id, description: def.description, meta: {} }),
    })
    expect(defineUuid({ id: "deadbeef", description: "x" }).id).toBe(
      "deadbeef",
    )
    expect(() => defineUuid({ id: "not-hex", description: "x" })).toThrow(
      /invalid id 'not-hex'/,
    )
  })

  it("exposes the default constants", () => {
    expect(DOCTYPE_DEFAULT_ID_PATTERN.test("ok")).toBe(true)
    expect(DOCTYPE_MAX_DESCRIPTION_LEN).toBe(2000)
  })
})
