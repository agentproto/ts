/**
 * `filters-applied-server-side` — every day-1 github definition maps its
 * subscription args to explicit Sentinel match clauses the runtime applies
 * server-side before delivery, and validates args against its `inputSchema`.
 * Also asserts the WIRE shape has no internal `replayable` field.
 */

import { describe, expect, it } from "vitest"

import {
  GITHUB_SCHEME,
  validateAgainstInputSchema,
  type EventRegistration,
} from "../../mcp-events/events-registry.js"

describe("filters-applied-server-side", () => {
  it("every github definition maps PR args to a server-side match clause", () => {
    expect(GITHUB_SCHEME.scheme).toBe("github")
    expect(GITHUB_SCHEME.events.length).toBeGreaterThan(0)
    for (const event of GITHUB_SCHEME.events) {
      const result = event.meta.argumentsToMatch({ repo: "agentproto/ts", number: 1428 })
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.providerSlug).toBe("local-gh")
      expect(result.matchClauses).toEqual([
        { subject: "github:agentproto/ts#1428", types: [event.definition.name] },
      ])
    }
  })

  it("rejects malformed args with a definition-specific reason", () => {
    for (const event of GITHUB_SCHEME.events) {
      expect(event.meta.argumentsToMatch({ repo: "not-a-repo", number: 1 })).toEqual({
        ok: false,
        reason: "`repo` must be `owner/name`",
      })
      expect(event.meta.argumentsToMatch({ repo: "o/r", number: 0 })).toEqual({
        ok: false,
        reason: "`number` must be a positive integer",
      })
    }
  })

  it("validates args against the definition inputSchema (missing/extra/type)", () => {
    const event = GITHUB_SCHEME.events[0] as EventRegistration
    expect(validateAgainstInputSchema(event.definition.inputSchema, { repo: "o/r", number: 3 })).toEqual({ ok: true })
    expect(validateAgainstInputSchema(event.definition.inputSchema, { repo: "o/r" }).ok).toBe(false)
    expect(validateAgainstInputSchema(event.definition.inputSchema, { repo: "o/r", number: 3, extra: 1 }).ok).toBe(false)
    expect(validateAgainstInputSchema(event.definition.inputSchema, { repo: "o/r", number: "3" }).ok).toBe(false)
  })

  it("the wire EventDefinition carries the official shape and NO internal replayable field", () => {
    for (const event of GITHUB_SCHEME.events) {
      const def = event.definition
      expect(def.delivery).toEqual(["webhook"])
      expect(typeof def.name).toBe("string")
      expect(typeof def.description).toBe("string")
      expect(typeof def.inputSchema).toBe("object")
      expect(typeof def.payloadSchema).toBe("object")
      expect(Object.keys(def).sort()).toEqual(["delivery", "description", "inputSchema", "name", "payloadSchema"])
      // internal only
      expect(event.meta.replayable).toBe(false)
    }
  })
})
