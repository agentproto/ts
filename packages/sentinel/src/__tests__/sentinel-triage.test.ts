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
  recordSentinelTriageKey,
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
    const firstEvent = push()
    const first = classifySentinelEvent(firstEvent, input(recent, 0))
    expect(first).toEqual({ decision: "wake", rule: "default" })
    recordSentinelTriageKey(firstEvent, input(recent, 0))

    const second = classifySentinelEvent(push({ id: "evt_2" }), input(recent, 60_000))
    expect(second).toEqual({ decision: "fyi", rule: "coalesced-repeat" })
  })

  it("a repeat counts per target, not globally", () => {
    const recent = new RecentKeys()
    const e1 = push()
    expect(classifySentinelEvent(e1, input(recent, 0, "sess_1"))).toEqual({
      decision: "wake",
      rule: "default",
    })
    recordSentinelTriageKey(e1, input(recent, 0, "sess_1"))
    expect(classifySentinelEvent(push({ id: "evt_2" }), input(recent, 1_000, "sess_2"))).toEqual({
      decision: "wake",
      rule: "default",
    })
  })

  it("failure: a failing verdict on the same head as an earlier pending tick still wakes", () => {
    const recent = new RecentKeys()
    const pending = makeEvent({
      type: "github.check_suite.completed",
      data: { headSha: "sha1", conclusion: null },
    })
    expect(classifySentinelEvent(pending, input(recent, 0))).toEqual({ decision: "wake", rule: "default" })
    recordSentinelTriageKey(pending, input(recent, 0))

    const failure = makeEvent({
      id: "evt_2",
      type: "github.check_suite.completed",
      data: { headSha: "sha1", conclusion: "failure" },
    })
    expect(classifySentinelEvent(failure, input(recent, 60_000))).toEqual({
      decision: "wake",
      rule: "failure",
    })
    recordSentinelTriageKey(failure, input(recent, 60_000))
    expect(
      classifySentinelEvent(
        makeEvent({
          id: "evt_3",
          type: "github.check_suite.completed",
          data: { headSha: "sha1", conclusion: "failure" },
        }),
        input(recent, 120_000),
      ),
    ).toEqual({ decision: "wake", rule: "failure" })
  })

  it("failure: a state or conclusion meaning failure, error, cancelled or timed_out wakes", () => {
    for (const data of [
      { headSha: "sha1", conclusion: "failure" },
      { headSha: "sha1", conclusion: "timed_out" },
      { headSha: "sha1", conclusion: "cancelled" },
      { headSha: "sha1", state: "error" },
    ]) {
      const result = classifySentinelEvent(
        makeEvent({ type: "github.check_suite.completed", data }),
        input(new RecentKeys(), 0),
      )
      expect(result).toEqual({ decision: "wake", rule: "failure" })
    }
  })

  it("fixed window: repeats do not refresh the first-seen time", () => {
    const recent = new RecentKeys()
    const first = makeEvent({
      type: "github.check_suite.completed",
      data: { headSha: "sha1", conclusion: null },
    })
    expect(classifySentinelEvent(first, input(recent, 0))).toEqual({ decision: "wake", rule: "default" })
    recordSentinelTriageKey(first, input(recent, 0))

    const second = makeEvent({
      id: "evt_2",
      type: "github.check_suite.completed",
      data: { headSha: "sha1", conclusion: null },
    })
    expect(classifySentinelEvent(second, input(recent, 9 * 60_000))).toEqual({
      decision: "fyi",
      rule: "coalesced-repeat",
    })
    recordSentinelTriageKey(second, input(recent, 9 * 60_000))

    const third = makeEvent({
      id: "evt_3",
      type: "github.check_suite.completed",
      data: { headSha: "sha1", conclusion: null },
    })
    expect(classifySentinelEvent(third, input(recent, 11 * 60_000))).toEqual({
      decision: "wake",
      rule: "default",
    })
  })

  it("different verdict on the same head is not a repeat", () => {
    const recent = new RecentKeys()
    const pending = makeEvent({
      type: "github.check_suite.completed",
      data: { headSha: "sha1", conclusion: null },
    })
    expect(classifySentinelEvent(pending, input(recent, 0))).toEqual({ decision: "wake", rule: "default" })
    recordSentinelTriageKey(pending, input(recent, 0))

    const success = makeEvent({
      id: "evt_2",
      type: "github.check_suite.completed",
      data: { headSha: "sha1", conclusion: "success" },
    })
    expect(classifySentinelEvent(success, input(recent, 60_000))).toEqual({
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
    const e1 = push()
    expect(classifySentinelEvent(e1, input(inside, 0))).toEqual({ decision: "wake", rule: "default" })
    recordSentinelTriageKey(e1, input(inside, 0))
    expect(
      classifySentinelEvent(push({ id: "evt_inside" }), input(inside, SENTINEL_TRIAGE_REPEAT_WINDOW_MS - 1)),
    ).toEqual({ decision: "fyi", rule: "coalesced-repeat" })

    const boundary = new RecentKeys()
    const e2 = push()
    expect(classifySentinelEvent(e2, input(boundary, 0))).toEqual({ decision: "wake", rule: "default" })
    recordSentinelTriageKey(e2, input(boundary, 0))
    expect(
      classifySentinelEvent(push({ id: "evt_boundary" }), input(boundary, SENTINEL_TRIAGE_REPEAT_WINDOW_MS)),
    ).toEqual({ decision: "wake", rule: "default" })
  })
})

describe("classifySentinelEvent: review and check verdicts that need action", () => {
  const review = (state: string, over?: Partial<SentinelEvent>): SentinelEvent =>
    makeEvent({ type: "github.pull_request_review.submitted", data: { action: "submitted", state }, ...over })
  const check = (conclusion: string): SentinelEvent =>
    makeEvent({ type: "github.check_suite.completed", data: { conclusion, headSha: "sha1" } })

  it("changes_requested wakes as a failure-class verdict in either casing, even on a repeat", () => {
    for (const state of ["changes_requested", "CHANGES_REQUESTED", "Changes_Requested"]) {
      const recent = new RecentKeys()
      const first = review(state)
      expect(classifySentinelEvent(first, input(recent, 0))).toEqual({ decision: "wake", rule: "failure" })
      recordSentinelTriageKey(first, input(recent, 0))
      expect(classifySentinelEvent(review(state, { id: "evt_2" }), input(recent, 1_000))).toEqual({
        decision: "wake",
        rule: "failure",
      })
    }
  })

  it("action_required wakes as a failure-class verdict", () => {
    expect(classifySentinelEvent(check("action_required"), input(new RecentKeys(), 0))).toEqual({
      decision: "wake",
      rule: "failure",
    })
  })

  it("approved and commented reviews are not failures, in either casing", () => {
    for (const state of ["approved", "APPROVED", "commented", "COMMENTED"]) {
      expect(classifySentinelEvent(review(state), input(new RecentKeys(), 0))).toEqual({
        decision: "wake",
        rule: "default",
      })
    }
  })

  it("the repeat key is case-insensitive so a provider's casing never splits one verdict in two", () => {
    const recent = new RecentKeys()
    recordSentinelTriageKey(check("SUCCESS"), input(recent, 0))
    expect(classifySentinelEvent(check("success"), input(recent, 1_000))).toEqual({
      decision: "fyi",
      rule: "coalesced-repeat",
    })
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

  it("does not record the classifying event; the caller records after a successful delivery", () => {
    const recent = new RecentKeys()
    expect(classifySentinelEvent(push(), input(recent, 0))).toEqual({ decision: "wake", rule: "default" })
    expect(recent.size).toBe(0)
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

  it("appends eventTs and key when available, and still no summary or data", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-triage-"))
    const filePath = join(dir, "sentinel-triage.jsonl")
    try {
      writeSentinelTriageLedger(filePath, {
        ts: "2026-10-01T00:05:00.000Z",
        decision: "wake",
        rule: "failure",
        target: "sess_1",
        sentinelId: "sen_1",
        eventId: "evt_1",
        type: "github.check_suite.completed",
        subject: "github:acme/widgets#42",
        urgency: "next-turn",
        eventTs: "2026-10-01T00:00:00.000Z",
        key: "sentinel:github-ci:ci:github:acme/widgets#42:sha1|failure",
      })

      const raw = readFileSync(filePath, "utf8")
      const line = JSON.parse(raw.trim())
      expect(line).toEqual({
        ts: "2026-10-01T00:05:00.000Z",
        source: "sentinel",
        applied: false,
        decision: "wake",
        rule: "failure",
        target: "sess_1",
        sentinelId: "sen_1",
        eventId: "evt_1",
        type: "github.check_suite.completed",
        subject: "github:acme/widgets#42",
        urgency: "next-turn",
        eventTs: "2026-10-01T00:00:00.000Z",
        key: "sentinel:github-ci:ci:github:acme/widgets#42:sha1|failure",
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
