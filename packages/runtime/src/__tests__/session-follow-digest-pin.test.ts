/**
 * Must-wake follow events (awaiting-input, crashed, a turn-end carrying a
 * question) are pinned through both digest caps: the merge cap on a busy
 * follower's waiting digest and the render cap on the digest text. A digest
 * without must-wake entries keeps the old truncation exactly.
 */
import { describe, expect, it } from "vitest"

import {
  FOLLOW_DIGEST_MAX_LINES,
  FOLLOW_DIGEST_MERGE_MAX_ENTRIES,
  formatFollowDigest,
  mergeQueuedDigests,
} from "../session-follow.js"
import type { DigestEntry } from "../sessions.js"

const TS = "2026-10-25T00:00:00.000Z"
const NOW_MS = Date.parse("2026-10-27T00:30:00.000Z")

function exited(id: string, detail = `${id} done`): DigestEntry {
  return { sessionId: id, event: "exited", ts: TS, label: id, text: detail }
}

function crashed(id: string): DigestEntry {
  return { sessionId: id, event: "crashed", ts: TS, label: id, text: `${id} died` }
}

function awaiting(id: string): DigestEntry {
  return {
    sessionId: id,
    event: "awaiting-input",
    ts: TS,
    label: id,
    awaitingInput: true,
    text: `${id} asks`,
  }
}

const noDesc = (): undefined => undefined

describe("follow digest pinning", () => {
  it("merge never drops an older awaiting-input and counts only non-must-wake omissions", () => {
    const old: DigestEntry[] = [
      awaiting("waiting"),
      ...Array.from({ length: 49 }, (_, i) => exited(`old-${i}`)),
    ]
    const incoming = Array.from({ length: 10 }, (_, i) => exited(`new-${i}`))

    const merged = mergeQueuedDigests({ entries: old, omitted: 0 }, { entries: incoming, omitted: 0 })

    expect(merged.entries).toHaveLength(FOLLOW_DIGEST_MERGE_MAX_ENTRIES)
    expect(merged.entries[0]?.sessionId).toBe("waiting")
    expect(merged.entries.some(e => e.sessionId === "waiting")).toBe(true)
    expect(merged.entries.at(-1)?.sessionId).toBe("new-9")
    expect(merged.omitted).toBe(10)
  })

  it("merge keeps every must-wake entry even when they alone exceed the cap", () => {
    const old = Array.from({ length: 30 }, (_, i) => crashed(`old-${i}`))
    const incoming = Array.from({ length: 30 }, (_, i) => crashed(`new-${i}`))

    const merged = mergeQueuedDigests({ entries: old, omitted: 0 }, { entries: incoming, omitted: 0 })

    expect(merged.entries).toHaveLength(60)
    expect(merged.entries.map(e => e.sessionId)).toEqual([
      ...old.map(e => e.sessionId),
      ...incoming.map(e => e.sessionId),
    ])
    expect(merged.omitted).toBe(0)
  })

  it("render pins a crashed line that falls outside the cap and keeps the hidden count accurate", () => {
    const entries = Array.from({ length: 60 }, (_, i) => (i === 40 ? crashed("crash-40") : exited(`s-${i}`)))

    const text = formatFollowDigest(entries, entry => entry.text, noDesc, "wake", 0, 1, NOW_MS)
    const lines = text.split("\n")

    expect(text).toContain("crash-40 (crash-40) crashed")
    expect(lines.filter(line => line.startsWith("[session-follow] s-") || line.includes("crashed"))).toHaveLength(
      FOLLOW_DIGEST_MAX_LINES,
    )
    expect(text).toContain("[session-follow] … and 20 more event(s)")
  })

  it("render truncates a digest with no must-wake entries exactly as before", () => {
    const entries = Array.from({ length: 45 }, (_, i) => exited(`s-${i}`))

    const text = formatFollowDigest(entries, entry => entry.text, noDesc, "wake", 0, 1, NOW_MS)
    const expected = [
      `[session-follow] automatic digest \u2014 45 events from sessions you follow. ` +
        `Decide whether anything needs the human's attention; if not, no reply is needed.`,
      ...entries
        .slice(0, FOLLOW_DIGEST_MAX_LINES)
        .map(entry => `[session-follow] ${entry.label} (${entry.sessionId}) ${entry.event} [il y a 2 j, 25/10 00:00Z] \u2014 ${entry.text}`),
      "[session-follow] … and 5 more event(s)",
    ].join("\n")

    expect(text).toBe(expected)
  })

  it("render tags each line with its age and UTC time; pr-merged reads as the forge merge time", () => {
    const merged: DigestEntry = {
      sessionId: "sess_42946c3a",
      event: "pr-merged",
      ts: "2026-10-29T05:28:51Z",
      label: "aip-dogfood-S10",
      text: "PR #144 merged",
    }
    const text = formatFollowDigest([merged], entry => entry.text, noDesc, "wake", 0, 1, Date.parse("2026-11-16T23:40:00Z"))
    expect(text).toContain(
      "aip-dogfood-S10 (sess_42946c3a) pr-merged [fusionnée il y a 18 j, 29/10 05:28Z] \u2014 PR #144 merged",
    )
  })
})
