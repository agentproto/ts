import { describe, it, expect } from "vitest"
import {
  canonicalJsonString,
  computeChainSignature,
  chainRow,
} from "./compute.js"

describe("canonicalJsonString", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJsonString({ z: 1, a: 2, m: { y: 3, b: 4 } })).toBe(
      '{"a":2,"m":{"b":4,"y":3},"z":1}'
    )
  })

  it("drops undefined values", () => {
    expect(canonicalJsonString({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  it("handles arrays in-order", () => {
    expect(canonicalJsonString([3, 1, 2])).toBe("[3,1,2]")
  })

  it("handles nested objects in arrays", () => {
    expect(canonicalJsonString([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]')
  })

  it("handles null and booleans", () => {
    expect(canonicalJsonString({ a: null, b: true, c: false })).toBe(
      '{"a":null,"b":true,"c":false}'
    )
  })

  it("escapes strings via JSON rules", () => {
    expect(canonicalJsonString({ s: 'a"b\\c' })).toBe('{"s":"a\\"b\\\\c"}')
  })

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJsonString({ n: NaN })).toThrow()
    expect(() => canonicalJsonString({ n: Infinity })).toThrow()
  })
})

describe("computeChainSignature", () => {
  const GENESIS = "0".repeat(64)
  const SECRET = "test-secret"

  it("produces 64-char lowercase hex", () => {
    const sig = computeChainSignature(
      {
        schema: "agentgovernance/v1",
        entityType: "test",
        entityId: "x",
        action: "x.y",
        createdAt: "2026-01-01T00:00:00.000Z",
        actorKind: "system",
        actorId: null,
        doctype: "audit-event",
        prevSignature: GENESIS,
      },
      GENESIS,
      SECRET
    )
    expect(sig).toMatch(/^[a-f0-9]{64}$/)
  })

  it("is deterministic", () => {
    const row = {
      schema: "agentgovernance/v1",
      entityType: "test",
      entityId: "x",
      action: "x.y",
      createdAt: "2026-01-01T00:00:00.000Z",
      actorKind: "system",
      actorId: null,
      doctype: "audit-event",
      prevSignature: GENESIS,
    }
    const s1 = computeChainSignature(row, GENESIS, SECRET)
    const s2 = computeChainSignature(row, GENESIS, SECRET)
    expect(s1).toBe(s2)
  })

  it("changes when prev_signature changes", () => {
    const row = {
      schema: "agentgovernance/v1",
      entityType: "test",
      entityId: "x",
      action: "x.y",
      createdAt: "2026-01-01T00:00:00.000Z",
      actorKind: "system",
      actorId: null,
      doctype: "audit-event",
      prevSignature: GENESIS,
    }
    const s1 = computeChainSignature(row, GENESIS, SECRET)
    const otherPrev = "f".repeat(64)
    const row2 = { ...row, prevSignature: otherPrev }
    const s2 = computeChainSignature(row2, otherPrev, SECRET)
    expect(s1).not.toBe(s2)
  })

  it("changes when secret changes", () => {
    const row = {
      schema: "agentgovernance/v1",
      entityType: "test",
      entityId: "x",
      action: "x.y",
      createdAt: "2026-01-01T00:00:00.000Z",
      actorKind: "system",
      actorId: null,
      doctype: "audit-event",
      prevSignature: GENESIS,
    }
    const s1 = computeChainSignature(row, GENESIS, SECRET)
    const s2 = computeChainSignature(row, GENESIS, "other-secret")
    expect(s1).not.toBe(s2)
  })

  it("ignores the existing signature field on the row", () => {
    const row = {
      schema: "agentgovernance/v1",
      entityType: "test",
      entityId: "x",
      action: "x.y",
      createdAt: "2026-01-01T00:00:00.000Z",
      actorKind: "system",
      actorId: null,
      doctype: "audit-event",
      prevSignature: GENESIS,
      signature: "deadbeef",
    }
    const s1 = computeChainSignature(row, GENESIS, SECRET)
    const s2 = computeChainSignature(
      { ...row, signature: "cafebabe" },
      GENESIS,
      SECRET
    )
    expect(s1).toBe(s2)
  })
})

describe("chainRow", () => {
  it("populates prevSignature and signature fields", () => {
    const result = chainRow(
      {
        schema: "agentgovernance/v1",
        doctype: "audit-event",
        actorKind: "system",
        actorId: null,
        entityType: "test",
        entityId: "x",
        action: "test.run",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "0".repeat(64),
      "test-secret"
    )
    expect(result.prevSignature).toBe("0".repeat(64))
    expect(result.signature).toMatch(/^[a-f0-9]{64}$/)
  })
})
