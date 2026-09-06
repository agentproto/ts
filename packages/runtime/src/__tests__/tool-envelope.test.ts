import { describe, expect, it } from "vitest"
import {
  decodeCursor,
  encodeCursor,
  paginate,
  pageParamsShape,
  toolText,
  type CursorPayload,
  type Page,
} from "../tool-envelope.js"

describe("encodeCursor / decodeCursor", () => {
  it("roundtrips a payload", () => {
    const payload: CursorPayload = { k: "abc", i: 7 }
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload)
  })

  it("roundtrips a numeric key and null key", () => {
    expect(decodeCursor(encodeCursor({ k: 42, i: 0 }))).toEqual({ k: 42, i: 0 })
    expect(decodeCursor(encodeCursor({ k: null, i: 3 }))).toEqual({ k: null, i: 3 })
  })

  it("returns null for garbage tokens", () => {
    expect(decodeCursor("not-a-cursor!!!")).toBeNull()
    expect(decodeCursor("")).toBeNull()
  })

  it("returns null for valid base64 of non-JSON text", () => {
    expect(decodeCursor(Buffer.from("hello world", "utf8").toString("base64url"))).toBeNull()
  })

  it("returns null for out-of-schema JSON payloads", () => {
    const badK = Buffer.from(JSON.stringify({ k: true, i: 1 }), "utf8").toString("base64url")
    expect(decodeCursor(badK)).toBeNull()

    const negativeI = Buffer.from(JSON.stringify({ k: "x", i: -1 }), "utf8").toString("base64url")
    expect(decodeCursor(negativeI)).toBeNull()

    const missingI = Buffer.from(JSON.stringify({ k: "x" }), "utf8").toString("base64url")
    expect(decodeCursor(missingI)).toBeNull()
  })
})

describe("paginate", () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` }))

  it("defaults to limit 50", () => {
    const page = paginate(items, {}, { maxLimit: 100 })
    expect(page.items).toHaveLength(50)
    expect(page.total).toBe(120)
  })

  it("clamps limit to maxLimit", () => {
    const page = paginate(items, { limit: 500 }, { maxLimit: 100 })
    expect(page.items).toHaveLength(100)
  })

  it("floors limit at 1", () => {
    expect(paginate(items, { limit: 0 }, { maxLimit: 100 }).items).toHaveLength(1)
    expect(paginate(items, { limit: -5 }, { maxLimit: 100 }).items).toHaveLength(1)
  })

  it("returns nextCursor mid-list with the correct decoded index", () => {
    const page = paginate(items, { limit: 50 }, { maxLimit: 100 })
    expect(page.nextCursor).toBeDefined()
    const decoded = decodeCursor(page.nextCursor ?? "")
    expect(decoded).toEqual({ k: null, i: 50 })
  })

  it("omits nextCursor on the last page", () => {
    const all = paginate(items, { limit: 200 }, { maxLimit: 500 })
    expect(all.items).toHaveLength(120)
    expect(all.nextCursor).toBeUndefined()
  })

  it("resumes from a cursor's index", () => {
    const first = paginate(items, { limit: 50 }, { maxLimit: 100 })
    const second = paginate(items, { cursor: first.nextCursor, limit: 50 }, { maxLimit: 100 })
    expect(second.items[0]).toEqual({ id: 51, name: "item-51" })
    expect(second.items).toHaveLength(50)
  })

  it("ignores an invalid cursor and starts from the beginning", () => {
    const page = paginate(items, { cursor: "garbage!!!" }, { maxLimit: 100 })
    expect(page.items[0]).toEqual({ id: 1, name: "item-1" })
  })

  it("records keyOf's value in nextCursor's k", () => {
    const page = paginate(items, { limit: 10 }, { maxLimit: 100, keyOf: (it) => it.id })
    const decoded = decodeCursor(page.nextCursor ?? "")
    expect(decoded?.k).toBe(11)
    expect(decoded?.i).toBe(10)
  })

  it("defaults k to null when no keyOf is given", () => {
    const page = paginate(items, { limit: 10 }, { maxLimit: 100 })
    expect(decodeCursor(page.nextCursor ?? "")?.k).toBeNull()
  })

  it("reports total as the full list length, not the page size", () => {
    const page = paginate(items, { limit: 5 }, { maxLimit: 100 })
    expect(page.items).toHaveLength(5)
    expect(page.total).toBe(120)
  })

  it("handles an empty list", () => {
    const page: Page<{ id: number }> = paginate([], {}, { maxLimit: 100 })
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeUndefined()
    expect(page.total).toBe(0)
  })
})

describe("toolText", () => {
  it("serializes compactly (no pretty-print whitespace)", () => {
    const text = toolText({ items: [{ id: 1 }], total: 1 })
    expect(text).toBe(JSON.stringify({ items: [{ id: 1 }], total: 1 }))
    expect(text).not.toContain("\n")
  })

  it("fields: absent → byte-identical to the plain serialization", () => {
    const page: Page<{ id: number; name: string }> = {
      items: [{ id: 1, name: "a" }],
      total: 1,
    }
    expect(toolText(page)).toBe(toolText(page, {}))
  })

  it("fields: allowlist keeps only the named keys on every item", () => {
    const page: Page<{ id: number; name: string; extra: string }> = {
      items: [
        { id: 1, name: "a", extra: "x" },
        { id: 2, name: "b", extra: "y" },
      ],
      total: 2,
    }
    const parsed = JSON.parse(toolText(page, { fields: ["id", "name"] })) as Page<{
      id: number
      name: string
      extra: string
    }>
    expect(parsed.items).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ])
  })
})

describe("pageParamsShape", () => {
  it("validates a full params object", () => {
    const parsed = pageParamsShape.limit.parse(10)
    expect(parsed).toBe(10)
    expect(pageParamsShape.limit.safeParse(0).success).toBe(false)
    expect(pageParamsShape.limit.safeParse(201).success).toBe(false)
    expect(pageParamsShape.cursor.safeParse("tok").success).toBe(true)
    expect(pageParamsShape.fields.safeParse(["a", "b"]).success).toBe(true)
  })
})
