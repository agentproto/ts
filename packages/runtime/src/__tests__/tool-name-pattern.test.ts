import { describe, expect, it } from "vitest"
import { matchesAnyToolPattern, toolNameMatches } from "../tool-name-pattern.js"

describe("tool-name-pattern", () => {
  it("exact names match only themselves", () => {
    expect(toolNameMatches("get_issue", "get_issue")).toBe(true)
    expect(toolNameMatches("get_issue", "get_issues")).toBe(false)
  })
  it("`*` is a wildcard; everything else (dots, brackets) is literal", () => {
    expect(toolNameMatches("list_*", "list_prs")).toBe(true)
    expect(toolNameMatches("list_*", "xlist_prs")).toBe(false)
    expect(toolNameMatches("*_issue", "create_issue")).toBe(true)
    expect(toolNameMatches("*", "anything")).toBe(true)
    expect(toolNameMatches("a.b*", "a.bc")).toBe(true)
    expect(toolNameMatches("a.b*", "axbc")).toBe(false)
    expect(toolNameMatches("[x]*", "[x]y")).toBe(true)
  })
  it("matchesAnyToolPattern checks exact and pattern entries", () => {
    const set = new Set(["get_issue", "list_*"])
    expect(matchesAnyToolPattern(set, "get_issue")).toBe(true)
    expect(matchesAnyToolPattern(set, "list_x")).toBe(true)
    expect(matchesAnyToolPattern(set, "delete_x")).toBe(false)
  })
})
