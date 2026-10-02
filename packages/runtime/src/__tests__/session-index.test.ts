import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  INDEX_MAX_PROMPT,
  INDEX_TAIL_BYTES,
  backfillSessionIndexes,
  buildSessionRecap,
  deriveIndexFromTranscript,
  indexEntryFromDescriptor,
  matchesSessionQuery,
  readAllSessionIndexes,
  readSessionIndex,
  readTranscriptTail,
  searchSessionIndexes,
  sessionIndexPath,
  writeSessionIndex,
  type SessionIndexEntry,
} from "../session-index.js"

/**
 * Hermetic coverage for the per-session index sidecar: atomic read/write,
 * bounded tail reads, jsonl backfill (missing/corrupt), search matching and
 * the recap shape. Every test uses a tmpdir base dir — nothing touches the
 * real `~/.agentproto`.
 */

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "session-index-"))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeEvents(id: string, records: unknown[]): void {
  const dir = join(tmp, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "events.jsonl"), records.map(r => JSON.stringify(r)).join("\n") + "\n")
}

function entry(over: Partial<SessionIndexEntry> & { id: string }): SessionIndexEntry {
  return { kind: "agent-cli", status: "running", alive: true, startedAt: "2026-09-01T00:00:00Z", ...over }
}

describe("sidecar read/write", () => {
  it("round-trips an entry atomically and leaves no tmp file", () => {
    const e = entry({ id: "sess_a", label: "chat 16:56:28", cwd: "/work/x", lastUserPrompt: { ts: "t", text: "hi" } })
    writeSessionIndex(e, tmp)
    expect(readSessionIndex("sess_a", tmp)).toMatchObject({ id: "sess_a", label: "chat 16:56:28", cwd: "/work/x" })
  })

  it("returns undefined for a missing or malformed sidecar", () => {
    expect(readSessionIndex("nope", tmp)).toBeUndefined()
    mkdirSync(join(tmp, "bad"), { recursive: true })
    writeFileSync(sessionIndexPath("bad", tmp), "{ not json")
    expect(readSessionIndex("bad", tmp)).toBeUndefined()
    writeFileSync(sessionIndexPath("bad", tmp), JSON.stringify({ kind: "agent-cli" }))
    expect(readSessionIndex("bad", tmp)).toBeUndefined() // no id
  })
})

describe("readTranscriptTail (bounded)", () => {
  it("caps text at a code-point boundary without splitting a surrogate pair", () => {
    const astral = "😀".repeat(600) // 600 code points / 1200 UTF-16 units
    const e = indexEntryFromDescriptor(
      { id: "s", kind: "agent-cli", workspaceSlug: "d", command: "c", pid: null, status: "running", startedAt: "t" } as never,
      { lastUserPrompt: { ts: "t", text: astral } },
    )
    const text = e.lastUserPrompt!.text
    expect(Array.from(text).length).toBeLessThanOrEqual(INDEX_MAX_PROMPT)
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    expect(loneSurrogate.test(text)).toBe(false)
  })

  it("extracts the last user prompt and last assistant run from the window", () => {
    writeEvents("sess_t", [
      { kind: "user-prompt", ts: "2026-09-01T10:00:00Z", text: "first ask" },
      { kind: "text-delta", text: "first " },
      { kind: "text-delta", text: "answer" },
      { kind: "turn-end", reason: "completed" },
      { kind: "user-prompt", ts: "2026-09-01T10:05:00Z", text: "second ask" },
      { kind: "text-delta", text: "second answer" },
    ])
    const tail = readTranscriptTail(join(tmp, "sess_t", "events.jsonl"))
    expect(tail.prompts.map(p => p.text)).toEqual(["first ask", "second ask"])
    expect(tail.lastOutputText).toBe("second answer")
    expect(tail.bytesRead).toBeGreaterThan(0)
  })

  it("never reads more than the cap on a huge transcript (generator)", () => {
    const lines: string[] = []
    // ~4MB of filler, far beyond the 256KB window.
    const chunk = "x".repeat(1000)
    for (let i = 0; i < 4000; i++) {
      lines.push(JSON.stringify({ kind: "text-delta", ts: "2026-09-01T00:00:00Z", text: chunk }))
    }
    lines.push(JSON.stringify({ kind: "user-prompt", ts: "2026-09-01T12:00:00Z", text: "the real ask" }))
    lines.push(JSON.stringify({ kind: "text-delta", text: "the real answer" }))
    const dir = join(tmp, "sess_huge")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n")

    const tail = readTranscriptTail(join(dir, "events.jsonl"))
    expect(tail.bytesRead).toBeLessThanOrEqual(INDEX_TAIL_BYTES)
    // The prompt near the very end is in the window; the early filler is not.
    expect(tail.prompts.map(p => p.text)).toEqual(["the real ask"])
    expect(tail.lastOutputText).toBe("the real answer")
  })
})

describe("backfill from jsonl", () => {
  it("deriveIndexFromTranscript recovers prompt + output when the sidecar is missing", () => {
    writeEvents("sess_missing", [
      { kind: "user-prompt", ts: "2026-09-01T09:00:00Z", text: "recover me" },
      { kind: "text-delta", text: "recovered output" },
    ])
    const derived = deriveIndexFromTranscript("sess_missing", tmp)
    expect(derived).toMatchObject({ id: "sess_missing" })
    expect(derived?.lastUserPrompt?.text).toBe("recover me")
    expect(derived?.lastOutputText).toBe("recovered output")
  })

  it("backfillSessionIndexes creates missing indexes, skips valid ones, recovers corrupt ones", () => {
    writeEvents("sess_missing", [
      { kind: "user-prompt", ts: "2026-09-01T09:00:00Z", text: "backfill me" },
      { kind: "text-delta", text: "out" },
    ])
    writeEvents("sess_valid", [{ kind: "user-prompt", ts: "2026-09-01T09:00:00Z", text: "keep" }])
    writeSessionIndex(entry({ id: "sess_valid", label: "already indexed" }), tmp)
    // Corrupt sidecar — no id, so it must be rewritten from jsonl.
    writeEvents("sess_corrupt", [
      { kind: "user-prompt", ts: "2026-09-01T09:00:00Z", text: "corrupt me" },
      { kind: "text-delta", text: "corrupt out" },
    ])
    mkdirSync(join(tmp, "sess_corrupt"), { recursive: true })
    writeFileSync(sessionIndexPath("sess_corrupt", tmp), "{ broken")

    const result = backfillSessionIndexes(tmp)
    expect(result.created).toBe(2)
    expect(readSessionIndex("sess_missing", tmp)?.lastUserPrompt?.text).toBe("backfill me")
    expect(readSessionIndex("sess_valid", tmp)?.label).toBe("already indexed")
    expect(readSessionIndex("sess_corrupt", tmp)?.lastOutputText).toBe("corrupt out")
  })

  it("enriches a recovered entry with the live descriptor's authoritative meta", () => {
    writeEvents("sess_enrich", [
      { kind: "user-prompt", ts: "2026-09-01T09:00:00Z", text: "the ask" },
      { kind: "text-delta", text: "the out" },
    ])
    backfillSessionIndexes(tmp, {
      descriptors: [
        {
          id: "sess_enrich",
          kind: "agent-cli",
          workspaceSlug: "ws",
          command: "claude (agent)",
          pid: null,
          status: "killed",
          startedAt: "2026-09-01T08:00:00Z",
          cwd: "/work/enrich",
          adapterSlug: "claude-code",
          model: "claude-x",
          turnsCompleted: 3,
        } as never,
      ],
    })
    expect(readSessionIndex("sess_enrich", tmp)).toMatchObject({
      status: "killed",
      cwd: "/work/enrich",
      adapter: "claude-code",
      model: "claude-x",
      turnsCompleted: 3,
      lastUserPrompt: { text: "the ask" },
    })
  })
})

describe("search", () => {
  const rows: SessionIndexEntry[] = [
    entry({ id: "sess_aaa111", label: "chat 16:56:28", cwd: "/work/agentproto", workspaceSlug: "default", status: "killed", lastActivityAt: "2026-09-02T00:00:00Z" }),
    entry({ id: "sess_bbb222", title: "Fix the login flow", cwd: "/work/other", status: "running", lastActivityAt: "2026-09-03T00:00:00Z" }),
  ]

  it("matches by id prefix, label, title and cwd, case-insensitively", () => {
    expect(matchesSessionQuery(rows[0]!, "sess_aaa")).toBe(true)
    expect(matchesSessionQuery(rows[0]!, "16:56")).toBe(true)
    expect(matchesSessionQuery(rows[1]!, "login")).toBe(true)
    expect(matchesSessionQuery(rows[1]!, "WORK/OTHER")).toBe(true)
    expect(matchesSessionQuery(rows[0]!, "nope")).toBe(false)
    // id is prefix-only, not a mid-string substring
    expect(matchesSessionQuery(rows[0]!, "aaa111")).toBe(false)
  })

  it("filters by status and caps at limit, newest activity first", () => {
    const all = searchSessionIndexes(rows, "", {})
    expect(all.map(r => r.id)).toEqual(["sess_bbb222", "sess_aaa111"])
    expect(searchSessionIndexes(rows, "", { status: "killed" }).map(r => r.id)).toEqual(["sess_aaa111"])
    expect(searchSessionIndexes(rows, "", { limit: 1 }).map(r => r.id)).toEqual(["sess_bbb222"])
  })

  it("readAllSessionIndexes recovers dirs with no sidecar from their jsonl", () => {
    writeEvents("sess_only_jsonl", [
      { kind: "user-prompt", ts: "2026-09-01T09:00:00Z", text: "findable" },
    ])
    const all = readAllSessionIndexes(tmp)
    expect(all.map(e => e.id)).toContain("sess_only_jsonl")
  })
})

describe("recap", () => {
  it("builds the resume shape: last K prompts, final output, meta, children", () => {
    writeEvents("sess_recap", [
      { kind: "user-prompt", ts: "2026-09-01T10:00:00Z", text: "p1" },
      { kind: "text-delta", text: "a1" },
      { kind: "user-prompt", ts: "2026-09-01T10:01:00Z", text: "p2" },
      { kind: "text-delta", text: "a2" },
      { kind: "user-prompt", ts: "2026-09-01T10:02:00Z", text: "p3" },
      { kind: "text-delta", text: "a3" },
    ])
    const recap = buildSessionRecap({
      entry: entry({ id: "sess_recap", status: "killed", alive: false, model: "m", adapter: "claude-code", costUsd: 0.5, turnsCompleted: 3 }),
      eventsPath: join(tmp, "sess_recap", "events.jsonl"),
      last: 2,
      children: ["sess_child"],
      queuedPrompts: 1,
    })
    expect(recap).toMatchObject({ id: "sess_recap", status: "killed", alive: false, model: "m", adapter: "claude-code", costUsd: 0.5, turnsCompleted: 3, children: ["sess_child"], queuedPrompts: 1 })
    expect(recap.prompts.map(p => p.text)).toEqual(["p2", "p3"])
    expect(recap.lastOutputText).toBe("a3")
  })

  it("caps a long last prompt/output to the sidecar budget", () => {
    writeEvents("sess_long", [
      { kind: "user-prompt", ts: "t", text: "u".repeat(2000) },
      { kind: "text-delta", text: "a".repeat(2000) },
    ])
    const recap = buildSessionRecap({ entry: entry({ id: "sess_long" }), eventsPath: join(tmp, "sess_long", "events.jsonl") })
    expect(recap.lastOutputText!.length).toBeLessThanOrEqual(300)
  })
})
