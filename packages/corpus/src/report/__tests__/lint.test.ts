import { describe, it, expect } from "vitest"
import { lintReportConfig } from "../lint.js"

describe("lintReportConfig", () => {
  it("is silent on a clean config", () => {
    const messages = lintReportConfig({
      dataset: "corpus",
      title: "State of Orchestration",
      cover: { brand: "AGENTIK", subtitle: "A study" },
      chapters: [
        { id: "ch01", title: "1. One", cover: "cover the landscape", cap: 20 },
      ],
    })
    expect(messages).toEqual([])
  })

  it("suggests the alias for chapters[].brief → cover", () => {
    const messages = lintReportConfig({
      chapters: [{ id: "ch01", title: "1. One", brief: "cover this" }],
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/^WARN /)
    expect(messages[0]).toContain("chapters[0]")
    expect(messages[0]).toContain("brief")
    expect(messages[0]).toContain('"cover"')
  })

  it("suggests the alias for chapters[].claimCap → cap", () => {
    const messages = lintReportConfig({
      chapters: [{ id: "ch01", title: "1. One", claimCap: 28 }],
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/^WARN /)
    expect(messages[0]).toContain("claimCap")
    expect(messages[0]).toContain('"cap"')
  })

  it("suggests aliases for keywords → kw and maxClaims → cap", () => {
    const messages = lintReportConfig({
      chapters: [
        { id: "ch01", title: "1. One", keywords: ["a"], maxClaims: 10 },
      ],
    })
    expect(messages).toHaveLength(2)
    expect(messages.find((m) => m.includes("keywords"))).toContain('"kw"')
    expect(messages.find((m) => m.includes("maxClaims"))).toContain('"cap"')
  })

  it("lists informational passthroughs as INFO, not WARN", () => {
    const messages = lintReportConfig({
      writer: "house style",
      citationStyle: "footnote",
      render: "pdf",
      chapters: [],
    })
    expect(messages).toHaveLength(3)
    for (const m of messages) expect(m).toMatch(/^INFO /)
  })

  it("flags a fully unknown key with a generic warning", () => {
    const messages = lintReportConfig({
      totallyMadeUp: true,
      chapters: [],
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/^WARN /)
    expect(messages[0]).toContain("totallyMadeUp")
  })

  it("includes the chapter id in the message when present", () => {
    const messages = lintReportConfig({
      chapters: [{ id: "landscape", title: "Landscape", brief: "x" }],
    })
    expect(messages[0]).toContain("(landscape)")
  })

  it("returns [] for non-object input", () => {
    expect(lintReportConfig(null)).toEqual([])
    expect(lintReportConfig("not a config")).toEqual([])
    expect(lintReportConfig(42)).toEqual([])
  })

  it("ignores chapters that aren't objects", () => {
    expect(() => lintReportConfig({ chapters: ["nope", null, 5] })).not.toThrow()
    expect(lintReportConfig({ chapters: ["nope", null, 5] })).toEqual([])
  })
})
