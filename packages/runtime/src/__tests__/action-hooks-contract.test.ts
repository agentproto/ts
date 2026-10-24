/**
 * Contract tests for the internal action-hooks module: admission precedence,
 * native expressiveness, AIP-39 action ids, and AIP-71 occurrence keys.
 */

import { describe, expect, it } from "vitest"

import {
  buildOccurrenceKey,
  combineAdmissionDecisions,
  isActionKind,
  isNativeExpressible,
  parseOccurrenceKey,
  type AdmissionDecision,
} from "../action-hooks/index.js"

const allow = (): AdmissionDecision => ({ outcome: "allow" })
const deny = (): AdmissionDecision => ({ outcome: "deny", code: "denied", message: "denied" })
const reuse = (): AdmissionDecision => ({ outcome: "reuse", targetId: "target", code: "reused" })
const defer = (): AdmissionDecision => ({ outcome: "defer", queueEntryId: "queue", code: "deferred" })

const RANK: Record<AdmissionDecision["outcome"], number> = {
  deny: 3,
  reuse: 2,
  defer: 1,
  allow: 0,
}

const makers = { allow, deny, reuse, defer } as const
const outcomes = ["allow", "deny", "reuse", "defer"] as const

describe("combineAdmissionDecisions", () => {
  for (const left of outcomes) {
    for (const right of outcomes) {
      it(`${left} then ${right}`, () => {
        const first = makers[left]()
        const second = makers[right]()
        const expected = RANK[first.outcome] >= RANK[second.outcome] ? first : second
        expect(combineAdmissionDecisions([first, second])).toBe(expected)
      })
    }
  }

  it("lets the strongest outcome win regardless of order", () => {
    const decision = deny()
    expect(combineAdmissionDecisions([allow(), defer(), reuse(), decision])).toBe(decision)
  })

  it("allows an empty list", () => {
    expect(combineAdmissionDecisions([])).toEqual({ outcome: "allow" })
  })
})

describe("isNativeExpressible", () => {
  it("accepts allow and deny only", () => {
    expect(isNativeExpressible(allow())).toBe(true)
    expect(isNativeExpressible(deny())).toBe(true)
    expect(isNativeExpressible(reuse())).toBe(false)
    expect(isNativeExpressible(defer())).toBe(false)
  })
})

describe("isActionKind", () => {
  it("accepts the runtime action ids and a tool id", () => {
    for (const id of [
      "session:spawn",
      "session:prompt",
      "session:control",
      "session:configure",
      "model:invoke",
      "auth-profile:use",
      "tool:read-file",
    ]) {
      expect(isActionKind(id)).toBe(true)
    }
  })

  it("rejects malformed ids", () => {
    for (const id of [
      "session",
      "Session:spawn",
      "a:b:c",
      ":x",
      "x:",
      "-a:b",
      `a:${"b".repeat(79)}`,
    ]) {
      expect(isActionKind(id)).toBe(false)
    }
  })
})

describe("occurrence keys", () => {
  it("round trips a plain key", () => {
    const parts = {
      sessionId: "sess-1",
      event: "turn-end",
      occurrenceId: "occ-1",
      bindingId: "binding-1",
    }
    expect(parseOccurrenceKey(buildOccurrenceKey(parts))).toEqual(parts)
  })

  it("round trips a binding id that contains slashes", () => {
    const parts = {
      sessionId: "sess-1",
      event: "turn-end",
      occurrenceId: "occ-1",
      bindingId: "agent-1/on/turn-end/0",
    }
    const key = buildOccurrenceKey(parts)
    expect(key).toBe("sess-1/turn-end/occ-1/agent-1/on/turn-end/0")
    expect(parseOccurrenceKey(key)).toEqual(parts)
  })

  it("returns undefined for malformed keys", () => {
    for (const key of [
      "a/b/c",
      "a//c/d",
      "a/b/c/",
      "a/b/c/d e",
    ]) {
      expect(parseOccurrenceKey(key)).toBeUndefined()
    }
  })

  it("throws when a first three segment contains a slash", () => {
    const base = {
      sessionId: "sess-1",
      event: "turn-end",
      occurrenceId: "occ-1",
      bindingId: "binding-1",
    }
    expect(() => buildOccurrenceKey({ ...base, sessionId: "a/b" })).toThrow(/session id/)
    expect(() => buildOccurrenceKey({ ...base, event: "a/b" })).toThrow(/event/)
    expect(() => buildOccurrenceKey({ ...base, occurrenceId: "a/b" })).toThrow(/occurrence id/)
  })

  it("throws on an empty segment", () => {
    const base = {
      sessionId: "sess-1",
      event: "turn-end",
      occurrenceId: "occ-1",
      bindingId: "binding-1",
    }
    expect(() => buildOccurrenceKey({ ...base, sessionId: "" })).toThrow(/session id/)
    expect(() => buildOccurrenceKey({ ...base, event: "" })).toThrow(/event/)
    expect(() => buildOccurrenceKey({ ...base, occurrenceId: "" })).toThrow(/occurrence id/)
    expect(() => buildOccurrenceKey({ ...base, bindingId: "" })).toThrow(/binding id/)
  })
})

describe("AdmissionDecision types", () => {
  it("requires queueEntryId on a defer decision", () => {
    // @ts-expect-error defer requires queueEntryId
    const incomplete: AdmissionDecision = { outcome: "defer" }
    expect(incomplete).toBeDefined()
  })
})
