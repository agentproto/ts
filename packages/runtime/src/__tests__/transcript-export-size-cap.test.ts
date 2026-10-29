/**
 * Size ceilings on the brain's transcript reader.
 *
 * In-process, temp dirs only: `exportDaemonEventsSession` is driven against a
 * hand-written `events.jsonl`, and `readSessionForBrainWithLimits` against an
 * isolated `$HOME` bucket. No daemon, no real session.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_BRAIN_MAX_TRANSCRIPT_BYTES,
  DEFAULT_BRAIN_MAX_TRANSCRIPT_TEXT_BYTES,
  resolveBrainIngestLimits,
} from "../brain-ingest-limits.js"
import { CONVERSATION_STORES, type ConversationStore } from "../conversation-store.js"
import { exportDaemonEventsSession } from "../transcript-export.js"
import { readSessionForBrainWithLimits } from "../workspace-brains.js"

const SESSION_ID = "sess_size_cap"

interface TooLargeLike {
  reason?: string
  sizeBytes?: number
  ceilingBytes?: number
}

function writeEvents(baseDir: string, sessionId: string, lines: unknown[]): void {
  const dir = join(baseDir, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "events.jsonl"),
    lines.map(line => JSON.stringify(line)).join("\n") + "\n",
    "utf8",
  )
}

describe("exportDaemonEventsSession size ceilings", () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "events-size-cap-"))
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it("refuses a file above the byte ceiling before parsing it", async () => {
    const filler = "x".repeat(4_000)
    writeEvents(baseDir, SESSION_ID, [
      { kind: "user-prompt", text: filler, ts: "2026-01-01T00:00:00Z" },
      { kind: "text-delta", text: filler, ts: "2026-01-01T00:00:01Z" },
      { kind: "turn-end", ts: "2026-01-01T00:00:02Z" },
    ])

    const error = await exportDaemonEventsSession(
      SESSION_ID,
      undefined,
      baseDir,
      { maxFileBytes: 100, maxTextBytes: 100 * 1024 * 1024 },
    ).then(
      () => undefined,
      err => err as unknown,
    )

    expect(error).toBeDefined()
    const tooLarge = error as TooLargeLike
    expect(tooLarge.reason).toBe("file-size")
    expect(tooLarge.sizeBytes).toBeGreaterThan(100)
    expect(tooLarge.ceilingBytes).toBe(100)
  })

  it("stops accumulating when a small file expands past the text ceiling", async () => {
    // Each line is tiny; the expanded message text is what grows past 2 KB.
    const lines: unknown[] = [
      { kind: "user-prompt", text: "go", ts: "2026-01-01T00:00:00Z" },
    ]
    for (let i = 0; i < 200; i++) {
      lines.push({
        kind: "text-delta",
        text: "chunk-of-text-",
        ts: "2026-01-01T00:00:01Z",
      })
    }
    lines.push({ kind: "turn-end", ts: "2026-01-01T00:00:02Z" })
    writeEvents(baseDir, SESSION_ID, lines)

    const error = await exportDaemonEventsSession(
      SESSION_ID,
      undefined,
      baseDir,
      { maxFileBytes: 1024 * 1024, maxTextBytes: 2_048 },
    ).then(
      () => undefined,
      err => err as unknown,
    )

    expect(error).toBeDefined()
    const tooLarge = error as TooLargeLike
    expect(tooLarge.reason).toBe("text-size")
    expect(tooLarge.sizeBytes).toBeGreaterThan(2_048)
    expect(tooLarge.ceilingBytes).toBe(2_048)
  })

  it("exports a normal session exactly as before when it fits the ceilings", async () => {
    writeEvents(baseDir, SESSION_ID, [
      { kind: "user-prompt", text: "what changed?", ts: "2026-01-01T00:00:00Z" },
      { kind: "text-delta", text: "Only the cap.", ts: "2026-01-01T00:00:01Z" },
      { kind: "turn-end", ts: "2026-01-01T00:00:02Z" },
    ])

    const exported = await exportDaemonEventsSession(
      SESSION_ID,
      undefined,
      baseDir,
      { maxFileBytes: 1024 * 1024, maxTextBytes: 1024 * 1024 },
    )

    expect(exported.messages).toEqual([
      expect.objectContaining({ role: "user", text: "what changed?" }),
      expect.objectContaining({ role: "assistant", text: "Only the cap." }),
    ])
  })
})

describe("resolveBrainIngestLimits", () => {
  it("falls back per field on non-positive or non-finite values", () => {
    expect(
      resolveBrainIngestLimits({
        maxTranscriptBytes: 0,
        maxTranscriptTextBytes: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      maxTranscriptBytes: DEFAULT_BRAIN_MAX_TRANSCRIPT_BYTES,
      maxTranscriptTextBytes: DEFAULT_BRAIN_MAX_TRANSCRIPT_TEXT_BYTES,
    })
    expect(
      resolveBrainIngestLimits({
        maxTranscriptBytes: -1,
        maxTranscriptTextBytes: Number.NaN,
      }),
    ).toEqual({
      maxTranscriptBytes: DEFAULT_BRAIN_MAX_TRANSCRIPT_BYTES,
      maxTranscriptTextBytes: DEFAULT_BRAIN_MAX_TRANSCRIPT_TEXT_BYTES,
    })
    expect(
      resolveBrainIngestLimits({
        maxTranscriptBytes: 123,
        maxTranscriptTextBytes: 456,
      }),
    ).toEqual({ maxTranscriptBytes: 123, maxTranscriptTextBytes: 456 })
  })
})

describe("readSessionForBrainWithLimits size ceiling", () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    previousHome = process.env.HOME
    home = mkdtempSync(join(tmpdir(), "brain-read-cap-"))
    process.env.HOME = home

    const bucket = join(home, ".agentproto", "workspaces", "default")
    mkdirSync(bucket, { recursive: true })
    writeFileSync(
      join(bucket, "conversations.jsonl"),
      JSON.stringify({
        sessionId: SESSION_ID,
        workspace: "default",
        cwd: "/tmp",
        adapterSlug: "unmapped-test-adapter",
        adapterSessionId: "adapter-1",
        agentprotoTranscript: "",
        startedAt: "2026-01-01T00:00:00Z",
      }) + "\n",
      "utf8",
    )
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it("returns a too-large skip result without materializing the transcript", async () => {
    const filler = "y".repeat(4_000)
    writeEvents(join(home, ".agentproto", "sessions"), SESSION_ID, [
      { kind: "user-prompt", text: filler, ts: "2026-01-01T00:00:00Z" },
      { kind: "text-delta", text: filler, ts: "2026-01-01T00:00:01Z" },
      { kind: "turn-end", ts: "2026-01-01T00:00:02Z" },
    ])

    const result = await readSessionForBrainWithLimits(SESSION_ID, {
      maxTranscriptBytes: 100,
      maxTranscriptTextBytes: 1024 * 1024,
    })

    expect(result).toEqual({
      skippedReason: "too-large",
      skippedSizeBytes: expect.any(Number),
      skippedCeilingBytes: 100,
    })
    expect((result as { skippedSizeBytes: number }).skippedSizeBytes).toBeGreaterThan(100)
    expect("messages" in (result as object)).toBe(false)
  })

  it("counts native-store reasoning and tool-call args toward the text ceiling", async () => {
    const bucket = join(home, ".agentproto", "workspaces", "default")
    writeFileSync(
      join(bucket, "conversations.jsonl"),
      JSON.stringify({
        sessionId: SESSION_ID,
        workspace: "default",
        cwd: "/tmp",
        adapterSlug: "native-size-test",
        adapterSessionId: "adapter-1",
        agentprotoTranscript: "",
        startedAt: "2026-01-01T00:00:00Z",
      }) + "\n",
      "utf8",
    )
    const store = {
      storeAs: "claudeResumeId",
      discover: async () => [],
      read: async () => ({
        meta: {},
        messages: [
          {
            role: "assistant",
            text: "small",
            reasoning: "r".repeat(2_000),
          },
          {
            role: "assistant",
            toolCalls: [{ name: "bash", args: "a".repeat(2_000) }],
          },
        ],
      }),
    } as unknown as ConversationStore
    CONVERSATION_STORES["native-size-test"] = store

    try {
      const result = await readSessionForBrainWithLimits(SESSION_ID, {
        maxTranscriptBytes: 1024 * 1024,
        maxTranscriptTextBytes: 3_000,
      })

      expect(result).toEqual({
        skippedReason: "too-large",
        skippedSizeBytes: expect.any(Number),
        skippedCeilingBytes: 3_000,
      })
      expect((result as { skippedSizeBytes: number }).skippedSizeBytes).toBeGreaterThan(
        3_000,
      )
    } finally {
      delete CONVERSATION_STORES["native-size-test"]
    }
  })
})
