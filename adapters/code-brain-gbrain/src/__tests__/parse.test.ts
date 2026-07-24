/**
 * Parser unit tests against fixtures captured verbatim from the live
 * `gbrain-pg` container (v0.42.62.0) — see `../__fixtures__/`. These pin the
 * exact wire shapes the two backends emit so a gbrain output change is caught
 * here rather than in a flaky live run:
 *
 *   - code-def:  CLI `results[]`  vs  HTTP `defs[]`
 *   - query:     CLI text lines   vs  HTTP JSON array
 *   - callers/callees: shared JSON envelope; edges carry no location
 */

import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import {
  parseSymbolDef,
  parseCallEdges,
  parseQueryText,
  parseQueryJson,
  extractLocation,
} from "../parse.js"

function fixture(name: string): string {
  return readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8")
}

describe("parseSymbolDef", () => {
  it("parses the CLI `results[]` envelope", () => {
    const def = parseSymbolDef("ImporterRunner", fixture("code-def.cli.json"))
    expect(def).not.toBeNull()
    expect(def?.symbol).toBe("ImporterRunner")
    expect(def?.kind).toBe("class")
    expect(def?.file).toBe("packages/corpus/src/importers/runner.ts")
    expect(def?.span).toEqual({ startLine: 34, endLine: 161 })
    expect(def?.signature).toContain("class ImporterRunner")
  })

  it("parses the HTTP `defs[]` envelope identically", () => {
    const def = parseSymbolDef("ImporterRunner", fixture("code-def.http.json"))
    expect(def?.file).toBe("packages/corpus/src/importers/runner.ts")
    expect(def?.span).toEqual({ startLine: 34, endLine: 161 })
    expect(def?.kind).toBe("class")
  })

  it("returns null when gbrain resolved no definition", () => {
    const empty = JSON.stringify({
      symbol: "Nope",
      count: 0,
      status: "ready",
      ready: true,
      results: [],
    })
    expect(parseSymbolDef("Nope", empty)).toBeNull()
  })
})

describe("parseCallEdges", () => {
  it("parses CLI callers, mapping qualified endpoints and stubbing location", () => {
    const edges = parseCallEdges(fixture("code-callers.cli.json"), "callers")
    expect(edges).toHaveLength(2)
    expect(edges[0]).toEqual({
      from: "ImporterRunner",
      to: "ImporterRunner",
      file: "",
      span: { startLine: 0, endLine: 0 },
    })
    expect(edges[1]?.from).toBe("fakeRunner")
    expect(edges[1]?.to).toBe("ImporterRunner")
  })

  it("parses CLI callees", () => {
    const edges = parseCallEdges(fixture("code-callees.cli.json"), "callees")
    expect(edges).toHaveLength(1)
    expect(edges[0]?.from).toBe("ImporterRunner")
  })

  it("returns [] for an async-indexing (not-yet-built) envelope", () => {
    const edges = parseCallEdges(fixture("code-callers.http.json"), "callers")
    expect(edges).toEqual([])
  })
})

describe("parseQueryText (CLI)", () => {
  it("parses `[score] slug -- snippet` hits with multi-line snippets", () => {
    const hits = parseQueryText(fixture("query.cli.txt"))
    expect(hits.length).toBeGreaterThanOrEqual(3)
    const first = hits[0]
    expect(first?.title).toBe("packages-corpus-src-importers-types-ts")
    expect(first?.score).toBeCloseTo(0.9059, 4)
    expect(first?.file).toBe("packages/corpus/src/importers/types.ts")
    expect(first?.span).toEqual({ startLine: 90, endLine: 102 })
    // the first hit's snippet wraps onto following lines — body must include them
    expect(first?.body).toContain("interface Corpu")
  })
})

describe("parseQueryJson (HTTP)", () => {
  it("parses the JSON-array hits and recovers location from chunk_text", () => {
    const hits = parseQueryJson(fixture("query.http.json"))
    expect(hits.length).toBeGreaterThanOrEqual(3)
    const first = hits[0]
    expect(first?.title).toBe("src/providers/corpus/index.ts (typescript)")
    expect(first?.score).toBeCloseTo(0.8419, 3)
    expect(first?.file).toBe("src/providers/corpus/index.ts")
    expect(first?.span).toEqual({ startLine: 30, endLine: 30 })
  })
})

describe("extractLocation", () => {
  it("pulls file + span from a `[Lang] path:start-end` header", () => {
    expect(extractLocation("[TypeScript] packages/foo/bar.ts:12-34 class Bar")).toEqual({
      file: "packages/foo/bar.ts",
      span: { startLine: 12, endLine: 34 },
    })
  })

  it("returns {} when there is no location header", () => {
    expect(extractLocation("just some prose with no header")).toEqual({})
  })
})
