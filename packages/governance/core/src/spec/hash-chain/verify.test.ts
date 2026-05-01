import { describe, it, expect } from "vitest"
import { chainRow } from "./compute.js"
import { verifyChain } from "./verify.js"

const GENESIS = "0".repeat(64)
const SECRET = "test-secret"

function makeRow(action: string, idx: number): Record<string, unknown> {
  return {
    schema: "agentgovernance/v1",
    doctype: "audit-event",
    actorKind: "system",
    actorId: null,
    entityType: "test",
    entityId: `test:${idx}`,
    action,
    createdAt: new Date(2026, 0, 1, 0, idx).toISOString(),
  }
}

function buildChain(actions: string[]): { jsonl: string; lines: string[] } {
  let prev = GENESIS
  const lines: string[] = []
  for (let i = 0; i < actions.length; i++) {
    const chained = chainRow(makeRow(actions[i]!, i), prev, SECRET)
    lines.push(JSON.stringify(chained))
    prev = chained.signature as string
  }
  return { jsonl: lines.join("\n"), lines }
}

describe("verifyChain", () => {
  it("verifies a clean 3-line chain", () => {
    const { jsonl } = buildChain([
      "log.initialized",
      "test.action_1",
      "test.action_2",
    ])
    const result = verifyChain(jsonl, { secret: SECRET, genesisSeed: GENESIS })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.verifiedLines).toBe(3)
      expect(result.lastSignature).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it("verifies an empty chain (zero lines)", () => {
    const result = verifyChain("", { secret: SECRET, genesisSeed: GENESIS })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.verifiedLines).toBe(0)
      expect(result.lastSignature).toBe(GENESIS)
    }
  })

  it("detects field tampering with signature_mismatch", () => {
    const { lines } = buildChain([
      "log.initialized",
      "test.action_1",
      "test.action_2",
    ])
    const tampered = [...lines]
    const r1 = JSON.parse(tampered[1]!)
    r1.action = "test.tampered"
    tampered[1] = JSON.stringify(r1)
    const result = verifyChain(tampered.join("\n"), {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.brokenAtLine).toBe(1)
      expect(result.reason).toBe("signature_mismatch")
    }
  })

  it("detects line removal with prev_signature_mismatch", () => {
    const { lines } = buildChain([
      "log.initialized",
      "test.action_1",
      "test.action_2",
    ])
    // Remove line 1
    const tampered = [lines[0]!, lines[2]!]
    const result = verifyChain(tampered.join("\n"), {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.brokenAtLine).toBe(1)
      expect(result.reason).toBe("prev_signature_mismatch")
    }
  })

  it("detects line reordering", () => {
    const { lines } = buildChain([
      "log.initialized",
      "test.action_1",
      "test.action_2",
    ])
    const tampered = [lines[0]!, lines[2]!, lines[1]!]
    const result = verifyChain(tampered.join("\n"), {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Either prev_signature_mismatch or signature_mismatch at line 1
      expect(result.brokenAtLine).toBe(1)
    }
  })

  it("rejects malformed JSON with parse_error", () => {
    const { lines } = buildChain(["log.initialized"])
    const tampered = [lines[0]!, "{not valid json"]
    const result = verifyChain(tampered.join("\n"), {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("parse_error")
      expect(result.brokenAtLine).toBe(1)
    }
  })

  it("rejects non-hex genesisSeed", () => {
    const result = verifyChain("", { secret: SECRET, genesisSeed: "not-hex" })
    expect(result.ok).toBe(false)
  })

  it("verifies a sub-range when rangeStart/rangeEnd given", () => {
    const { jsonl } = buildChain(["a.x", "b.x", "c.x", "d.x"])
    const result = verifyChain(jsonl, {
      secret: SECRET,
      genesisSeed: GENESIS,
      rangeStart: 1,
      rangeEnd: 2,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.verifiedLines).toBe(2) // lines 1 and 2 only
    }
  })
})
