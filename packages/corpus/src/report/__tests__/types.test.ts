import { describe, it, expect } from "vitest"
import { reportChapterSchema, reportConfigSchema, reportCoverPageSchema } from "../types.js"

describe("reportCoverPageSchema", () => {
  it("accepts the new optional body field", () => {
    const parsed = reportCoverPageSchema.parse({ title: "Cover", body: "Back-cover blurb." })
    expect(parsed.body).toBe("Back-cover blurb.")
  })

  it("still parses without body (backward compatible)", () => {
    const parsed = reportCoverPageSchema.parse({ title: "Cover" })
    expect(parsed.body).toBeUndefined()
  })
})

describe("reportChapterSchema", () => {
  it("accepts an optional artifact block", () => {
    const parsed = reportChapterSchema.parse({
      id: "ch03",
      title: "3. MCP Server",
      artifact: {
        path: "chapters/03-mcp-server",
        files: ["src/server.ts"],
        run: "pnpm test",
      },
    })
    expect(parsed.artifact).toEqual({
      path: "chapters/03-mcp-server",
      files: ["src/server.ts"],
      run: "pnpm test",
    })
  })

  it("still parses without artifact (backward compatible)", () => {
    const parsed = reportChapterSchema.parse({ id: "ch01", title: "1. Intro" })
    expect(parsed.artifact).toBeUndefined()
  })
})

describe("reportConfigSchema", () => {
  it("accepts bundleRepo/pageSize/pageBleed/epub", () => {
    const parsed = reportConfigSchema.parse({
      bundleRepo: "../book-bundle",
      pageSize: "6in 9in",
      pageBleed: "3mm",
      epub: { out: "dist/book.epub", pandocArgs: ["--toc"] },
      chapters: [{ id: "ch01", title: "1. Intro" }],
    })
    expect(parsed.bundleRepo).toBe("../book-bundle")
    expect(parsed.pageSize).toBe("6in 9in")
    expect(parsed.pageBleed).toBe("3mm")
    expect(parsed.epub).toEqual({ out: "dist/book.epub", pandocArgs: ["--toc"] })
  })

  it("still parses without the new fields (backward compatible)", () => {
    const parsed = reportConfigSchema.parse({ chapters: [{ id: "ch01", title: "1. Intro" }] })
    expect(parsed.bundleRepo).toBeUndefined()
    expect(parsed.pageSize).toBeUndefined()
    expect(parsed.pageBleed).toBeUndefined()
    expect(parsed.epub).toBeUndefined()
  })
})
