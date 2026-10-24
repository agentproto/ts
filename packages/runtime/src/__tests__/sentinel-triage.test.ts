/**
 * Unit tests for the sentinel triage classifier (`sentinel-triage.ts`) and
 * its JSONL ledger writer: the three fixed rules (terminal, coalesced
 * repeat, default), the 10-minute repeat window boundary, the bounded
 * recent-key map, and the guarantee that the ledger carries no message text,
 * event data or summary.
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  classifySentinelEvent,
  createRecentKeys,
  REPEAT_WINDOW_MS,
  RECENT_KEYS_CAP,
  writeSentinelTriageLedger,
  type SentinelTriageLedgerLine,
} from "../sentinel-triage.js"
import { makeFakeEvent } from "../sentinel-providers/fake.js"
import type { SentinelEvent } from "../sentinel-providers/types.js"

const T0 = Date.parse("2026-10-01T00:00:00.000Z")

function ciEvent(over: Partial<SentinelEvent> & Pick<SentinelEvent, "id">): SentinelEvent {
  return makeFakeEvent({
    type: "github.check_suite.completed",
    subject: "github:acme/widgets#42",
    data: { headSha: "abc123" },
    ...over,
  })
}

describe("classifySentinelEvent", () => {
  it("rule terminal: a terminal event wakes, even when the same key was just seen", () => {
    const recent = createRecentKeys()
    const event = ciEvent({ id: "evt_1", terminal: true })
    recent.record("sess_1", "sentinel:github-ci:ci:github:acme/widgets#42:abc123", T0)

    const result = classifySentinelEvent(event, {
      target: "sess_1",
      sentinelId: "sen_1",
      now: T0 + 1_000,
      recent,
    })

    expect(result).toEqual({ decision: "wake", rule: "terminal" })
  })

  it("rule coalesced-repeat: the same (target, key) inside the window is fyi", () => {
    const recent = createRecentKeys()
    const first = ciEvent({ id: "evt_1" })
    const second = ciEvent({ id: "evt_2" })

    expect(
      classifySentinelEvent(first, { target: "sess_1", sentinelId: "sen_1", now: T0, recent }),
    ).toEqual({ decision: "wake", rule: "default" })
    expect(
      classifySentinelEvent(second, { target: "sess_1", sentinelId: "sen_1", now: T0 + 60_000, recent }),
    ).toEqual({ decision: "fyi", rule: "coalesced-repeat" })
  })

  it("rule coalesced-repeat is scoped to (target, key): another target or key wakes", () => {
    const recent = createRecentKeys()
    classifySentinelEvent(ciEvent({ id: "evt_1" }), {
      target: "sess_1",
      sentinelId: "sen_1",
      now: T0,
      recent,
    })

    const otherTarget = classifySentinelEvent(ciEvent({ id: "evt_2" }), {
      target: "sess_2",
      sentinelId: "sen_1",
      now: T0 + 1_000,
      recent,
    })
    expect(otherTarget).toEqual({ decision: "wake", rule: "default" })

    const otherKey = classifySentinelEvent(ciEvent({ id: "evt_3", data: { headSha: "def456" } }), {
      target: "sess_1",
      sentinelId: "sen_1",
      now: T0 + 1_000,
      recent,
    })
    expect(otherKey).toEqual({ decision: "wake", rule: "default" })
  })

  it("rule default: an event with no coalesce key wakes", () => {
    const recent = createRecentKeys()
    const result = classifySentinelEvent(makeFakeEvent({ id: "evt_1", type: "fake.a", subject: "fake:w" }), {
      target: "sess_1",
      sentinelId: "sen_1",
      now: T0,
      recent,
    })
    expect(result).toEqual({ decision: "wake", rule: "default" })
  })

  it("the repeat window boundary: just inside is fyi, exactly 10 minutes is not", () => {
    const recent = createRecentKeys()
    classifySentinelEvent(ciEvent({ id: "evt_1" }), {
      target: "sess_1",
      sentinelId: "sen_1",
      now: T0,
      recent,
    })

    const inside = classifySentinelEvent(ciEvent({ id: "evt_2" }), {
      target: "sess_1",
      sentinelId: "sen_1",
      now: T0 + REPEAT_WINDOW_MS - 1,
      recent,
    })
    expect(inside).toEqual({ decision: "fyi", rule: "coalesced-repeat" })

    // Re-record at T0 for an independent exact-boundary check.
    const exactRecent = createRecentKeys()
    exactRecent.record("sess_1", "sentinel:github-ci:ci:github:acme/widgets#42:abc123", T0)
    const atBoundary = classifySentinelEvent(ciEvent({ id: "evt_3" }), {
      target: "sess_1",
      sentinelId: "sen_1",
      now: T0 + REPEAT_WINDOW_MS,
      recent: exactRecent,
    })
    expect(atBoundary).toEqual({ decision: "wake", rule: "default" })
  })

  it("caps the recent-key map at 1000 entries and evicts the oldest", () => {
    const recent = createRecentKeys()
    expect(RECENT_KEYS_CAP).toBe(1000)
    for (let i = 0; i < RECENT_KEYS_CAP; i++) recent.record("sess_1", `key-${i}`, T0)
    // One more entry pushes the first one out (insertion order = oldest).
    recent.record("sess_1", "key-overflow", T0 + 1)

    expect(recent.has("sess_1", "key-0", T0 + 2)).toBe(false)
    expect(recent.has("sess_1", "key-1", T0 + 2)).toBe(true)
    expect(recent.has("sess_1", "key-overflow", T0 + 2)).toBe(true)
  })
})

describe("writeSentinelTriageLedger", () => {
  it("writes one JSON line carrying only the ledger fields, never summary/data", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-triage-ledger-"))
    const path = join(dir, "sentinel-triage.jsonl")
    try {
      const line = {
        ts: new Date(T0).toISOString(),
        source: "sentinel",
        applied: false,
        decision: "wake",
        rule: "default",
        target: "sess_1",
        sentinelId: "sen_1",
        eventId: "evt_1",
        type: "fake.widget.created",
        subject: "fake:widget-1",
        urgency: "next-turn",
        // Extra fields a careless caller might attach; the writer must drop them.
        summary: "SECRET SUMMARY",
        data: { secret: "SECRET DATA" },
        text: "SECRET TEXT",
      } as SentinelTriageLedgerLine & Record<string, unknown>

      writeSentinelTriageLedger(path, line)

      const raw = readFileSync(path, "utf8")
      expect(raw.endsWith("\n")).toBe(true)
      const parsed = JSON.parse(raw.trim()) as Record<string, unknown>
      expect(parsed).toEqual({
        ts: new Date(T0).toISOString(),
        source: "sentinel",
        applied: false,
        decision: "wake",
        rule: "default",
        target: "sess_1",
        sentinelId: "sen_1",
        eventId: "evt_1",
        type: "fake.widget.created",
        subject: "fake:widget-1",
        urgency: "next-turn",
      })
      expect(parsed.summary).toBeUndefined()
      expect(parsed.data).toBeUndefined()
      expect(parsed.text).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
