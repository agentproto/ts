import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  CANONICAL_SESSION_JSONL,
  CANONICAL_SESSION_RECORDS,
  type AgentprotoRawTranscriptRecord,
} from "../index.js"

const REQUIRED_KINDS = [
  "user-prompt",
  "thought",
  "text-delta",
  "tool-call",
  "tool-result",
  "tool-call-record",
  "permission-resolved",
  "notice",
  "turn-end",
] as const

describe("CANONICAL_SESSION_RECORDS", () => {
  it("is non-empty", () => {
    expect(CANONICAL_SESSION_RECORDS.length).toBeGreaterThan(0)
  })

  it("contains at least one record of every covered kind", () => {
    const kinds = new Set(CANONICAL_SESSION_RECORDS.map(r => r.kind))
    for (const kind of REQUIRED_KINDS) {
      expect(kinds.has(kind), `missing kind: ${kind}`).toBe(true)
    }
  })

  it("is in ascending seq sharing one sessionId", () => {
    const ids = new Set(CANONICAL_SESSION_RECORDS.map(r => r.sessionId))
    expect(ids.size).toBe(1)
    for (let i = 1; i < CANONICAL_SESSION_RECORDS.length; i++) {
      const prev = CANONICAL_SESSION_RECORDS[i - 1]
      const curr = CANONICAL_SESSION_RECORDS[i]
      expect(curr!).toBeDefined()
      expect(prev!).toBeDefined()
      expect(curr!.seq).toBeGreaterThan(prev!.seq)
    }
  })
})

describe("CANONICAL_SESSION_JSONL round-trip", () => {
  it("reparses line-by-line to valid JSON that exactly matches CANONICAL_SESSION_RECORDS", () => {
    const lines = CANONICAL_SESSION_JSONL.split("\n").filter(l => l.trim().length > 0)
    expect(lines.length).toBe(CANONICAL_SESSION_RECORDS.length)

    const reparsed: AgentprotoRawTranscriptRecord[] = lines.map(line => {
      const parsed = JSON.parse(line) as AgentprotoRawTranscriptRecord
      return parsed
    })

    expect(reparsed).toEqual(CANONICAL_SESSION_RECORDS)
  })

  it("each line carries seq + ts", () => {
    for (const line of CANONICAL_SESSION_JSONL.trim().split("\n")) {
      const obj = JSON.parse(line) as { seq?: unknown; ts?: unknown }
      expect(typeof obj.seq).toBe("number")
      expect(typeof obj.ts).toBe("string")
      expect(Number.isNaN(Date.parse(obj.ts as string))).toBe(false)
    }
  })
})

describe("fixtures/canonical-session.jsonl on-disk file", () => {
  it("matches CANONICAL_SESSION_RECORDS (anti-drift with the committed file)", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    // From src/__tests__ -> ../../fixtures/canonical-session.jsonl
    const filePath = resolve(here, "..", "..", "fixtures", "canonical-session.jsonl")
    const fileText = readFileSync(filePath, "utf8")

    const fileLines = fileText.split("\n").filter(l => l.trim().length > 0)
    const fileRecords = fileLines.map(line => JSON.parse(line) as AgentprotoRawTranscriptRecord)

    expect(fileRecords).toEqual(CANONICAL_SESSION_RECORDS)
  })
})