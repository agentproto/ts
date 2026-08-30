import { describe, it, expect } from "vitest"

import {
  appendChangelog,
  CATALOG_CHANGELOG_HEADER,
  diffModelIds,
  extractRecordIds,
  renderChangelogSection,
} from "../changelog.js"

const BEFORE = `export const ROUTES: Record<string, X> = {
  "vendor/a": {
    inputPer1M: 1,
  },
  "vendor/b": {
    inputPer1M: 2,
  },
}
`

const AFTER_WITH_ADD_AND_REMOVE = `export const ROUTES: Record<string, X> = {
  "vendor/a": {
    inputPer1M: 1,
  },
  "vendor/c": {
    inputPer1M: 3,
  },
}
`

describe("extractRecordIds", () => {
  it("extracts only top-level (2-space-indented) quoted keys", () => {
    const src = `export const X: Record<string, Y> = {
  "top/level": {
    nested: "not/a/top/level/key",
  },
}
`
    expect(extractRecordIds(src)).toEqual(new Set(["top/level"]))
  })

  it("returns an empty set for content with no Record entries", () => {
    expect(extractRecordIds("export const MOCK = 42 as const\n")).toEqual(new Set())
  })
})

describe("diffModelIds", () => {
  it("reports no drift when content is unchanged", () => {
    expect(diffModelIds(BEFORE, BEFORE)).toEqual({ added: [], removed: [] })
  })

  it("reports added and removed ids across a real diff", () => {
    expect(diffModelIds(BEFORE, AFTER_WITH_ADD_AND_REMOVE)).toEqual({
      added: ["vendor/c"],
      removed: ["vendor/b"],
    })
  })

  it("treats a missing `before` as a brand-new file — every id is added, nothing removed", () => {
    expect(diffModelIds(undefined, BEFORE)).toEqual({
      added: ["vendor/a", "vendor/b"],
      removed: [],
    })
  })
})

describe("renderChangelogSection", () => {
  it("returns an empty string when every entry is empty (no drift to report)", () => {
    expect(
      renderChangelogSection("2026-08-31", [
        { generator: "llm:openrouter", added: [], removed: [] },
      ])
    ).toBe("")
    expect(renderChangelogSection("2026-08-31", [])).toBe("")
  })

  it("renders a dated section grouped by generator, skipping generators with no drift", () => {
    const section = renderChangelogSection("2026-08-31", [
      { generator: "llm:openrouter", added: [], removed: [] },
      { generator: "llm:requesty", added: ["vendor/new"], removed: ["vendor/old"] },
    ])
    expect(section).toContain("## 2026-08-31")
    expect(section).not.toContain("llm:openrouter")
    expect(section).toContain("### llm:requesty")
    expect(section).toContain("- Added: vendor/new")
    expect(section).toContain("- Removed: vendor/old")
  })
})

describe("appendChangelog", () => {
  it("returns undefined (leave the file untouched) when there's nothing to report", () => {
    expect(
      appendChangelog("existing content\n", "2026-08-31", [
        { generator: "llm:openrouter", added: [], removed: [] },
      ])
    ).toBeUndefined()
    expect(appendChangelog(undefined, "2026-08-31", [])).toBeUndefined()
  })

  it("creates the file with the standard header when it doesn't exist yet", () => {
    const out = appendChangelog(undefined, "2026-08-31", [
      { generator: "llm:requesty", added: ["vendor/new"], removed: [] },
    ])
    expect(out).toBeDefined()
    expect(out).toContain(CATALOG_CHANGELOG_HEADER.trim())
    expect(out).toContain("## 2026-08-31")
    expect(out).toContain("- Added: vendor/new")
  })

  it("appends at the END of existing content (newest last), preserving prior sections", () => {
    const existing = `${CATALOG_CHANGELOG_HEADER}\n## 2026-08-01\n\n### llm:openrouter\n- Added: vendor/old-add\n`
    const out = appendChangelog(existing, "2026-08-31", [
      { generator: "llm:requesty", added: ["vendor/new"], removed: [] },
    ])
    expect(out).toBeDefined()
    const idxOld = out!.indexOf("## 2026-08-01")
    const idxNew = out!.indexOf("## 2026-08-31")
    expect(idxOld).toBeGreaterThan(-1)
    expect(idxNew).toBeGreaterThan(idxOld)
    // Prior section content survives byte-for-byte.
    expect(out).toContain("- Added: vendor/old-add")
  })

  it("a second run with unchanged source appends nothing further (idempotent)", () => {
    const first = appendChangelog(undefined, "2026-08-31", [
      { generator: "llm:requesty", added: ["vendor/new"], removed: [] },
    ])
    // Re-running with zero drift (as diffModelIds would report once the
    // generated file already reflects vendor/new) must not touch the file.
    const second = appendChangelog(first, "2026-08-31", [
      { generator: "llm:requesty", added: [], removed: [] },
    ])
    expect(second).toBeUndefined()
  })
})
