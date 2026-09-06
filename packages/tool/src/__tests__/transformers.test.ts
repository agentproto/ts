import { describe, expect, it } from "vitest"
import { z } from "zod"
import { catchErrors, paginated, type McpTextResult } from "../transformers.js"
import type { ToolTransformer } from "../types.js"

interface Item {
  id: string
  name: string
  bulky: string
}

const items: Item[] = [
  { id: "a", name: "alpha", bulky: "A".repeat(100) },
  { id: "b", name: "beta", bulky: "B".repeat(100) },
  { id: "c", name: "gamma", bulky: "C".repeat(100) },
]

const compact = (i: Item) => ({ id: i.id, name: i.name })

function textOf(result: McpTextResult): string {
  expect(result.content).toHaveLength(1)
  expect(result.content[0]?.type).toBe("text")
  return result.content[0]?.text ?? ""
}

describe("catchErrors", () => {
  it("wraps a thrown Error into the canonical MCP error result", async () => {
    const t = catchErrors()
    const wrapped = t.wrapHandler(async () => {
      throw new Error("boom")
    })
    const result = (await wrapped({})) as McpTextResult
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "boom" }])
  })

  it("stringifies non-Error throws", async () => {
    const t = catchErrors()
    const wrapped = t.wrapHandler(async () => {
      throw "plain string"
    })
    const result = (await wrapped({})) as McpTextResult
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe("plain string")
  })

  it("passes successful results through untouched", async () => {
    const t = catchErrors()
    const wrapped = t.wrapHandler(async () => "ok")
    expect(await wrapped({})).toBe("ok")
  })

  it("has no wrapShape (adds no input params)", () => {
    expect(catchErrors().wrapShape).toBeUndefined()
  })
})

describe("paginated", () => {
  const transformer = paginated<Item>({ project: compact, keyOf: i => i.id, itemKey: "things" })
  const wrapped = transformer.wrapHandler(async () => items)

  it("wrapShape adds the shared page params to the declared shape", () => {
    const shape = transformer.wrapShape?.({ id: z.string() }) ?? {}
    expect(Object.keys(shape).sort()).toEqual(
      ["compact", "cursor", "fields", "full", "id", "limit"].sort(),
    )
  })

  it("without limit/cursor keeps the legacy wrapper key, compact by default", async () => {
    const parsed = JSON.parse(textOf((await wrapped({})) as McpTextResult)) as {
      things?: Array<Record<string, unknown>>
      items?: unknown[]
      total?: unknown
    }
    expect(parsed.things).toHaveLength(3)
    expect(parsed.items).toBeUndefined()
    expect(parsed.total).toBeUndefined()
    expect(parsed.things?.[0]).toEqual({ id: "a", name: "alpha" })
  })

  it("without limit/cursor, full:true escapes the projection", async () => {
    const parsed = JSON.parse(textOf((await wrapped({ full: true })) as McpTextResult)) as {
      things?: Item[]
    }
    expect(parsed.things?.[0]?.bulky).toBeDefined()
  })

  it("without limit/cursor, compact:false is the same escape hatch", async () => {
    const parsed = JSON.parse(textOf((await wrapped({ compact: false })) as McpTextResult)) as {
      things?: Item[]
    }
    expect(parsed.things?.[0]?.bulky).toBeDefined()
  })

  it("with limit returns the page envelope with projected rows", async () => {
    const parsed = JSON.parse(textOf((await wrapped({ limit: 2 })) as McpTextResult)) as {
      items: Array<Record<string, unknown>>
      nextCursor?: string
      total: number
    }
    expect(parsed.items).toHaveLength(2)
    expect(parsed.items[0]).toEqual({ id: "a", name: "alpha" })
    expect(parsed.total).toBe(3)
    expect(parsed.nextCursor).toBeDefined()
  })

  it("with limit + full:true returns unprojected rows in the same envelope", async () => {
    const parsed = JSON.parse(
      textOf((await wrapped({ limit: 2, full: true })) as McpTextResult),
    ) as { items: Item[]; total: number }
    expect(parsed.items[0]?.bulky).toBeDefined()
    expect(parsed.total).toBe(3)
  })

  it("fields is a per-item allowlist on the paginated envelope", async () => {
    const parsed = JSON.parse(
      textOf((await wrapped({ limit: 1, full: true, fields: ["id"] })) as McpTextResult),
    ) as { items: Array<Record<string, unknown>> }
    expect(Object.keys(parsed.items[0] ?? {})).toEqual(["id"])
  })

  it("cursor walks pages to cover the full list (shared cursor semantics)", async () => {
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const parsed = JSON.parse(
        textOf((await wrapped({ limit: 2, cursor })) as McpTextResult),
      ) as { items: Array<{ id: string }>; nextCursor?: string }
      seen.push(...parsed.items.map(i => i.id))
      cursor = parsed.nextCursor
    } while (cursor)
    expect(seen).toEqual(["a", "b", "c"])
  })

  it("clamps limit to maxLimit", async () => {
    const t = paginated<Item>({ project: compact, maxLimit: 2 })
    const w = t.wrapHandler(async () => items)
    const parsed = JSON.parse(textOf((await w({ limit: 100 })) as McpTextResult)) as {
      items: unknown[]
      nextCursor?: string
    }
    expect(parsed.items).toHaveLength(2)
    expect(parsed.nextCursor).toBeDefined()
  })

  it("defaults itemKey to 'items'", async () => {
    const t = paginated<Item>({ project: compact })
    const w = t.wrapHandler(async () => items)
    const parsed = JSON.parse(textOf((await w({})) as McpTextResult)) as {
      items?: unknown[]
    }
    expect(parsed.items).toHaveLength(3)
  })
})

describe("transformer composition contract", () => {
  it("wrapHandler folds so the FIRST declared transformer is the OUTERMOST wrapper", async () => {
    // Same fold rule toMcpTool applies — verified here at the type level.
    const outer: ToolTransformer<{ v: number }, { tag: string; inner: unknown }, { tag: string; inner: unknown }> = {
      name: "outer",
      wrapHandler: handler => async input => ({
        tag: "outer",
        inner: await handler(input),
      }),
    }
    const inner: ToolTransformer<{ v: number }, { v: number }, { tag: string; inner: unknown }> = {
      name: "inner",
      wrapHandler: handler => async input => ({
        tag: "inner",
        inner: await handler(input),
      }),
    }
    // Declared order [outer, inner] → outer wraps the result of inner
    // wrapping the base.
    const h = outer.wrapHandler(inner.wrapHandler(async input => ({ v: input.v })))
    expect(await h({ v: 1 })).toEqual({
      tag: "outer",
      inner: { tag: "inner", inner: { v: 1 } },
    })
  })
})
