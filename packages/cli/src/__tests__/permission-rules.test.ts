/**
 * Unit tests for `_permission-rules.ts` — the pure rule layer behind
 * `agentproto permissions watch`. These pin the safety-relevant semantics:
 * a nameless request never matches a tool pattern (even `*`), deny rules
 * compile ahead of allow rules, and `--rules-json` validation rejects
 * anything ambiguous instead of silently not matching.
 */

import { describe, it, expect } from "vitest"
import {
  compileToolPattern,
  compileRulesFromFlags,
  parseRulesJson,
  matchEntry,
  describeRule,
  type MatchableEntry,
} from "../commands/_permission-rules.js"

const entry = (over: Partial<MatchableEntry> = {}): MatchableEntry => ({
  id: "perm_1",
  sessionId: "s-abc",
  ...over,
})

describe("compileToolPattern", () => {
  it("an exact name matches only itself", () => {
    const re = compileToolPattern("ExitPlanMode")
    expect(re.test("ExitPlanMode")).toBe(true)
    expect(re.test("ExitPlanModeX")).toBe(false)
    expect(re.test("exitplanmode")).toBe(false) // case-sensitive
  })

  it("`*` globs: mcp__* matches prefixed names, not others", () => {
    const re = compileToolPattern("mcp__*")
    expect(re.test("mcp__github_search")).toBe(true)
    expect(re.test("Read")).toBe(false)
  })

  it("regex specials are literal: a.b does not match axb", () => {
    expect(compileToolPattern("a.b").test("axb")).toBe(false)
    expect(compileToolPattern("a.b").test("a.b")).toBe(true)
    expect(compileToolPattern("foo(bar)").test("foo(bar)")).toBe(true)
  })
})

describe("matchEntry", () => {
  it("a nameless entry never matches a tool pattern — even `*`", () => {
    const rules = compileRulesFromFlags({ allow: ["*"], deny: [] })
    expect(matchEntry(rules, entry({ toolName: undefined }))).toBeNull()
    expect(matchEntry(rules, entry({ toolName: "Read" }))).not.toBeNull()
  })

  it("rule sessionId matches the entry's sessionId or its label; mismatch → null", () => {
    const rules = compileRulesFromFlags({ allow: ["*"], deny: [], session: "worker-1" })
    expect(
      matchEntry(rules, entry({ toolName: "Read", sessionId: "worker-1" })),
    ).not.toBeNull()
    expect(
      matchEntry(rules, entry({ toolName: "Read", sessionLabel: "worker-1" })),
    ).not.toBeNull()
    expect(matchEntry(rules, entry({ toolName: "Read", sessionId: "s-other" }))).toBeNull()
  })

  it("first match wins across ordered rules", () => {
    const parsed = parseRulesJson([
      { match: { toolName: "Read*" }, decision: "approve" },
      { match: { toolName: "*" }, decision: "deny" },
    ])
    if (!parsed.ok) throw new Error(parsed.error)
    expect(matchEntry(parsed.rules, entry({ toolName: "ReadFile" }))?.decision).toBe("approve")
    expect(matchEntry(parsed.rules, entry({ toolName: "Bash" }))?.decision).toBe("deny")
  })

  it("a session-only rules-json rule is the explicit opt-in for nameless entries", () => {
    const parsed = parseRulesJson([{ match: { sessionId: "s-abc" }, decision: "approve" }])
    if (!parsed.ok) throw new Error(parsed.error)
    expect(matchEntry(parsed.rules, entry({ toolName: undefined }))).not.toBeNull()
  })
})

describe("compileRulesFromFlags", () => {
  it("deny rules come before allow rules (deny Bash + allow * → Bash denied)", () => {
    const rules = compileRulesFromFlags({ allow: ["*"], deny: ["Bash"] })
    expect(matchEntry(rules, entry({ toolName: "Bash" }))?.decision).toBe("deny")
    expect(matchEntry(rules, entry({ toolName: "Read" }))?.decision).toBe("approve")
  })

  it("--always sets scope on approve rules only", () => {
    const rules = compileRulesFromFlags({ allow: ["Read"], deny: ["Bash"], always: true })
    const denyRule = rules.find(r => r.decision === "deny")
    const allowRule = rules.find(r => r.decision === "approve")
    expect(denyRule?.scope).toBeUndefined()
    expect(allowRule?.scope).toBe("always")
  })

  it("--session is copied into every rule's match", () => {
    const rules = compileRulesFromFlags({ allow: ["A"], deny: ["B"], session: "s-1" })
    expect(rules.every(r => r.match.sessionId === "s-1")).toBe(true)
  })
})

describe("parseRulesJson", () => {
  it.each([
    [{ not: "an array" }, "must be a JSON array"],
    [[], "at least one rule"],
    [[{ match: { toolName: "X" }, decision: "yes" }], 'decision must be "approve" or "deny"'],
    [[{ match: {}, decision: "approve" }], "at least one of toolName/sessionId"],
    [[{ match: { toolName: "X" }, decision: "deny", scope: "always" }], "scope only applies to approve"],
    [[{ match: { toolName: "X" }, decision: "approve", optionId: 7 }], "optionId must be a string"],
    [[{ match: { toolName: "X" }, decision: "approve", scope: "sometimes" }], 'scope must be "once" or "always"'],
  ])("rejects %j", (input, errorFragment) => {
    const result = parseRulesJson(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(errorFragment)
  })

  it("accepts a full valid rule and preserves optionId/scope/sessionId", () => {
    const result = parseRulesJson([
      {
        match: { toolName: "ExitPlanMode", sessionId: "s-abc" },
        decision: "approve",
        optionId: "allow_once",
        scope: "once",
      },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      const rule = result.rules[0]!
      expect(rule.optionId).toBe("allow_once")
      expect(rule.scope).toBe("once")
      expect(rule.match.sessionId).toBe("s-abc")
      expect(describeRule(rule)).toBe("rule 1: approve ExitPlanMode @ s-abc")
    }
  })
})
