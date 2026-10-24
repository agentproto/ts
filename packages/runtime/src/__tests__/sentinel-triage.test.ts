/**
 * Unit tests for the observation-only sentinel triage (`sentinel-triage.ts`):
 * the ordered rules, the 10-minute repeat window and its boundary, the
 * bounded recent-key map, and the ledger shape (identifiers only, never the
 * event summary or `data`).
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_RECENT_KEYS_CAP,
  RecentKeys,
  SENTINEL_TRIAGE_REPEAT_WINDOW_MS,
  classifySentinelEvent,
  writeSentinelTriageLedger,
} from "../sentinel-triage.js"
import type { SentinelEvent } from "../sentinel-providers/types.js"

function makeEvent(over: Partial<SentinelEvent> & Pick<SentinelEvent, "type">): SentinelEvent {
  return {
    specversion: "1.0",
    id: "evt_1",
    source: "//agentproto.local/sentinel/local-gh",
    subject: "github:acme/widgets#42",
    time: "2026-10-01T00:00:00.000Z",
    datacontenttype: "application/json",
    data: {},
    summary: "x",
    subjects: ["github:acme/widgets#42", "github:acme/widgets", "github:acme"],
    terminal: false,
    ...over,
  }
}

const push = (over?: Partial<SentinelEvent>): SentinelEvent =>
  makeEvent({ type: "github.pull_request.synchronize", data: { headSha: "sha1" }, ...over })

const input = (recent: RecentKeys, now: number, target = "sess_1") => ({
  target,
  sentinelId: "sen_1",
  now,
  recent,
})

describe("classifySentinelEvent", () => {
  it("terminal wins first: a terminal event wakes even when its key is a recent repeat", () => {
    const recent = new RecentKeys()
    recent.record("sess_1", "sentinel:github-push:push:github:acme/widgets#42", 0)

    const result = classifySentinelEvent(push({ terminal: true }), input(recent, 60_000))
    expect(result).toEqual({ decision: "wake", rule: "terminal" })
  })

  it("coalesced-repeat: the same (target, key) within 10 minutes is fyi", () => {
    const recent = new RecentKeys()
    const first = classifySentinelEvent(push(), input(recent, 0))
    expect(first).toEqual({ decision: "wake", rule: "default" })

    const second = classifySentinelEvent(push({ id: "evt_2" }), input(recent, 60_000))
    expect(second).toEqual({ decision: "fyi", rule: "coalesced-repeat" })
  })

  it("a repeat counts per target, not globally", () => {
    const recent = new RecentKeys()
    expect(classifySentinelEvent(push(), input(recent, 0, "sess_1"))).toEqual({
      decision: "wake",
      rule: "default",
    })
    expect(classifySentinelEvent(push({ id: "evt_2" }), input(recent, 1_000, "sess_2"))).toEqual({
      decision: "wake",
      rule: "default",
    })
  })

  it("default: an event without a coalesce key always wakes", () => {
    const recent = new RecentKeys()
    const event = makeEvent({ type: "github.pull_request.closed" })
    expect(classifySentinelEvent(event, input(recent, 0))).toEqual({ decision: "wake", rule: "default" })
    expect(classifySentinelEvent({ ...event, id: "evt_2" }, input(recent, 1_000))).toEqual({
      decision: "wake",
      rule: "default",
    })
  })

  it("a key recorded exactly 10 minutes ago is no longer a repeat, just inside is", () => {
    const inside = new RecentKeys()
    expect(classifySentinelEvent(push(), input(inside, 0))).toEqual({ decision: "wake", rule: "default" })
    expect(
      classifySentinelEvent(push({ id: "evt_inside" }), input(inside, SENTINEL_TRIAGE_REPEAT_WINDOW_MS - 1)),
    ).toEqual({ decision: "fyi", rule: "coalesced-repeat" })

    const boundary = new RecentKeys()
    expect(classifySentinelEvent(push(), input(boundary, 0))).toEqual({ decision: "wake", rule: "default" })
    expect(
      classifySentinelEvent(push({ id: "evt_boundary" }), input(boundary, SENTINEL_TRIAGE_REPEAT_WINDOW_MS)),
    ).toEqual({ decision: "wake", rule: "default" })
  })
})

describe("RecentKeys", () => {
  it("is bounded at 1000 entries and evicts the oldest key", () => {
    const recent = new RecentKeys()
    expect(DEFAULT_RECENT_KEYS_CAP).toBe(1000)

    for (let i = 0; i < 1000; i++) recent.record("sess_1", `k${i}`, 0)
    expect(recent.size).toBe(1000)

    recent.record("sess_1", "k1000", 0)
    expect(recent.size).toBe(1000)
    expect(recent.has("sess_1", "k0", 0)).toBe(false)
    expect(recent.has("sess_1", "k1", 0)).toBe(true)
    expect(recent.has("sess_1", "k1000", 0)).toBe(true)
  })

  it("records the classifying event after deciding, so it is not its own repeat", () => {
    const recent = new RecentKeys()
    expect(classifySentinelEvent(push(), input(recent, 0))).toEqual({ decision: "wake", rule: "default" })
    expect(recent.size).toBe(1)
  })
})

describe("writeSentinelTriageLedger", () => {
  it("appends one identifier-only JSON line with source/applied fixed", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-triage-"))
    const filePath = join(dir, "nested", "sentinel-triage.jsonl")
    try {
      writeSentinelTriageLedger(filePath, {
        ts: "2026-10-01T00:00:00.000Z",
        decision: "fyi",
        rule: "coalesced-repeat",
        target: "sess_1",
        sentinelId: "sen_1",
        eventId: "evt_1",
        type: "github.pull_request.synchronize",
        subject: "github:acme/widgets#42",
        urgency: "next-turn",
      })

      const raw = readFileSync(filePath, "utf8")
      expect(raw.endsWith("\n")).toBe(true)
      const lines = raw.trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toEqual({
        ts: "2026-10-01T00:00:00.000Z",
        source: "sentinel",
        applied: false,
        decision: "fyi",
        rule: "coalesced-repeat",
        target: "sess_1",
        sentinelId: "sen_1",
        eventId: "evt_1",
        type: "github.pull_request.synchronize",
        subject: "github:acme/widgets#42",
        urgency: "next-turn",
      })
      expect(raw).not.toContain("summary")
      expect(raw).not.toContain("data")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("never throws on an unwritable path", () => {
    expect(() =>
      writeSentinelTriageLedger("\u0000not-a-path", {
        ts: "2026-10-01T00:00:00.000Z",
        decision: "wake",
        rule: "default",
        target: "sess_1",
        sentinelId: "sen_1",
        eventId: "evt_1",
        type: "fake",
        subject: "fake:thing",
        urgency: "next-turn",
      }),
    ).not.toThrow()
  })
})
