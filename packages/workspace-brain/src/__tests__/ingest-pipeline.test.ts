/**
 * Tests for {@link IngestPipeline} driven end-to-end through the REAL
 * `FilesKnowledgeAdapter` + `LocalFs` over a temp brain dir — so the "write a
 * source file under knowledge/sources/ and make it queryable" contract is
 * exercised for real, not stubbed.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FilesKnowledgeAdapter, LocalFs } from "@agentproto/adapter-knowledge-files"
import { createBrainState } from "../brain-state.js"
import { IngestPipeline } from "../ingest-pipeline.js"
import type { ExportedSessionLike } from "../types.js"

function transcript(title: string, body: string): ExportedSessionLike {
  return {
    meta: { title },
    messages: [
      { role: "user", text: "question about auth", ts: 1700000000000 },
      { role: "assistant", text: body, ts: 1700000001000 },
    ],
  }
}

function shortTranscript(title: string, keyword: string): ExportedSessionLike {
  return {
    meta: { title },
    messages: [
      { role: "user", text: "hi", ts: 1700000000000 },
      { role: "assistant", text: `${keyword} short answer`, ts: 1700000001000 },
    ],
  }
}

/** A many-turn transcript whose LAST turn carries a keyword that appears
 *  nowhere else — so a query for it can only be satisfied by the chunk that
 *  covers the transcript's tail, never the first chunk. */
function longTranscript(title: string, turnCount: number, keyword: string): ExportedSessionLike {
  const messages: Array<{ role: string; text: string; ts: number }> = []
  for (let i = 0; i < turnCount; i++) {
    const role = i % 2 === 0 ? "user" : "assistant"
    const text =
      i === turnCount - 1
        ? `filler filler filler filler ${keyword} unique to the final turn`
        : `filler filler filler filler turn number ${i} padding padding`
    messages.push({ role, text, ts: 1700000000000 + i * 1000 })
  }
  return { meta: { title }, messages }
}

describe("IngestPipeline", () => {
  let brainDir: string
  let state: ReturnType<typeof createBrainState>
  let adapter: FilesKnowledgeAdapter
  let pipeline: IngestPipeline
  let readSessionImpl: (ref: string) => Promise<ExportedSessionLike | null>

  const getProvider = () => adapter

  beforeEach(async () => {
    brainDir = await mkdtemp(path.join(tmpdir(), "brain-pipeline-"))
    state = createBrainState(brainDir)
    adapter = new FilesKnowledgeAdapter({
      fs: new LocalFs({ root: brainDir }),
      workspacePath: "knowledge",
    })
    readSessionImpl = async () => transcript("Fix auth", "The fix was in handle.ts")
    pipeline = new IngestPipeline({
      workspace: "test-ws",
      readSession: ref => readSessionImpl(ref),
      state,
      getProvider,
    })
  })

  afterEach(async () => {
    await rm(brainDir, { recursive: true, force: true })
  })

  it("ingests a session: writes the source file, records state, and makes it queryable", async () => {
    const result = await pipeline.ingest("sess-abc123")
    expect(result.ok).toBe(true)
    expect(result.sourceId).toBeDefined()
    expect(result.turnCount).toBe(2)

    // Source file landed under knowledge/sources/<session-id>.md
    const file = await readFile(path.join(brainDir, "knowledge", "sources", "sess-abc123.md"), "utf8")
    expect(file).toContain("The fix was in handle.ts")

    // State recorded
    const recorded = await state.read()
    expect(recorded["sess-abc123"]!.sessionId).toBe("sess-abc123")

    // Query returns the content
    const query = await adapter.query({ query: "handle" })
    expect(query.hits.length).toBeGreaterThan(0)
    expect(query.hits[0]!.text).toContain("handle.ts")
  })

  it("skips a session that was already ingested", async () => {
    await pipeline.ingest("sess-abc123")
    const second = await pipeline.ingest("sess-abc123")
    expect(second.skipped).toBe("already-ingested")
  })

  it("re-ingests on force", async () => {
    await pipeline.ingest("sess-abc123")
    const forced = await pipeline.ingest("sess-abc123", true)
    expect(forced.ok).toBe(true)
    expect(forced.skipped).toBeUndefined()
  })

  it("reports a session with no readable transcript as no-transcript", async () => {
    readSessionImpl = async () => null
    const result = await pipeline.ingest("sess-missing")
    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe("no-transcript")
  })

  it("reports an empty transcript as empty-transcript and writes nothing", async () => {
    readSessionImpl = async () => ({
      messages: [{ role: "tool", text: " " }],
    })
    const result = await pipeline.ingest("sess-empty")
    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe("empty-transcript")
    expect(await state.read()).toEqual({})
  })

  it("contains a throwing reader per-session without aborting", async () => {
    readSessionImpl = async () => {
      throw new Error("boom")
    }
    const result = await pipeline.ingest("sess-throw")
    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe("no-transcript")
  })

  it("records a no-transcript skip in brain-state.json", async () => {
    readSessionImpl = async () => null
    await pipeline.ingest("sess-missing")
    const skips = await state.readSkips()
    expect(skips["sess-missing"]).toMatchObject({
      sessionId: "sess-missing",
      reason: "no-transcript",
    })
  })

  it("records an empty-transcript skip in brain-state.json", async () => {
    readSessionImpl = async () => ({ messages: [{ role: "tool", text: " " }] })
    await pipeline.ingest("sess-empty")
    const skips = await state.readSkips()
    expect(skips["sess-empty"]).toMatchObject({
      sessionId: "sess-empty",
      reason: "empty-transcript",
    })
  })

  it("explicit re-ingest retries a previously skipped session regardless of the skip", async () => {
    readSessionImpl = async () => null
    await pipeline.ingest("sess-flaky")
    expect((await state.readSkips())["sess-flaky"]).toBeDefined()

    // The session later gets a real transcript (e.g. resumed) — a plain
    // (non-forced) re-ingest by id must still attempt it, not treat the
    // skip as a tombstone.
    readSessionImpl = async () => transcript("Fixed", "now it has a transcript")
    const result = await pipeline.ingest("sess-flaky")
    expect(result.ok).toBe(true)
    expect((await state.readSkips())["sess-flaky"]).toBeUndefined()
    expect((await state.read())["sess-flaky"]).toBeDefined()
  })

  it("ingestPending excludes sessions recorded as skipped from the backlog", async () => {
    readSessionImpl = async ref =>
      ref === "sess-ok" ? transcript("Fine", "all good") : null

    const withRefs = new IngestPipeline({
      workspace: "test-ws",
      readSession: ref => readSessionImpl(ref),
      state,
      getProvider,
      listSessionRefs: async () => ["sess-ok", "sess-bash-pty"],
    })

    const first = await withRefs.ingestPending()
    expect(first.attempted).toBe(2)
    expect(first.ingested).toBe(1)
    expect((await state.readSkips())["sess-bash-pty"]).toBeDefined()

    // sess-bash-pty is now recorded as skipped — a second backlog run must
    // not re-attempt it (only the already-ingested sess-ok would otherwise
    // also be excluded, but it's excluded via `recorded`, not `skips`).
    const second = await withRefs.ingestPending()
    expect(second.attempted).toBe(0)
  })

  it("ingestPending only ingests sessions not yet recorded", async () => {
    const withRefs = new IngestPipeline({
      workspace: "test-ws",
      readSession: ref => readSessionImpl(ref),
      state,
      getProvider,
      listSessionRefs: async () => ["sess-a", "sess-b", "sess-c"],
    })
    const report = await withRefs.ingestPending()
    expect(report.attempted).toBe(3)
    expect(report.ingested).toBe(3)
    expect(report.failed).toBe(0)
    expect(Object.keys(await state.read()).sort()).toEqual(["sess-a", "sess-b", "sess-c"])

    const second = await withRefs.ingestPending()
    expect(second.attempted).toBe(0)
    expect(second.ingested).toBe(0)
  })

  it("ingestPending is a no-op without a session lister", async () => {
    const report = await pipeline.ingestPending()
    expect(report.attempted).toBe(0)
  })

  it("a small transcript ingests as exactly one chunk", async () => {
    const result = await pipeline.ingest("sess-abc123")
    expect(result.chunkCount).toBe(1)
  })

  describe("chunked retrieval", () => {
    it("splits a long transcript into multiple sources and finds a LATE chunk via a real query", async () => {
      const tight = new IngestPipeline({
        workspace: "test-ws",
        readSession: async () => longTranscript("Long session", 20, "zzzlatekeyword"),
        state,
        getProvider,
        chunkMaxBytes: 150,
      })

      const result = await tight.ingest("sess-long")
      expect(result.ok).toBe(true)
      expect(result.chunkCount).toBeGreaterThan(1)

      // Every chunk landed as its own file under sources/.
      const files = await readdir(path.join(brainDir, "knowledge", "sources"))
      expect(files.length).toBe(result.chunkCount)

      // A later chunk's frontmatter correctly attributes it to the session.
      const laterChunkFile = files.find(f => f !== "sess-long.md")
      expect(laterChunkFile).toBeDefined()
      const laterContent = await readFile(
        path.join(brainDir, "knowledge", "sources", laterChunkFile!),
        "utf8",
      )
      expect(laterContent).toContain("sessionId: sess-long")
      expect(laterContent).toMatch(/chunkIndex: [1-9]/)
      expect(laterContent).toContain(`chunkCount: ${result.chunkCount}`)

      // The regression case: a query for text that only exists in the
      // transcript's tail must hit a chunk-level doc, not the whole
      // document — and its snippet must actually contain the match.
      const query = await adapter.query({ query: "zzzlatekeyword" })
      expect(query.hits.length).toBeGreaterThan(0)
      const hit = query.hits[0]!
      expect(hit.text).toContain("zzzlatekeyword")
      expect(hit.sourceId).not.toBe("sess-long")
      expect(hit.chunkId).toBe(hit.sourceId)
      expect(hit.metadata.sessionId).toBe("sess-long")
    })

    it("reindex grow: chunk 0 keeps its original path, new tail chunks are added", async () => {
      const tight = new IngestPipeline({
        workspace: "test-ws",
        readSession: () => readSessionImpl("sess-grow"),
        state,
        getProvider,
        chunkMaxBytes: 150,
      })

      readSessionImpl = async () => shortTranscript("Grow session", "growkeyword")
      const first = await tight.ingest("sess-grow")
      expect(first.chunkCount).toBe(1)
      expect(await adapter.query({ query: "growkeyword" }).then(r => r.hits.length)).toBeGreaterThan(0)

      readSessionImpl = async () => longTranscript("Grow session", 20, "growkeyword")
      const second = await tight.ingest("sess-grow", true)
      expect(second.ok).toBe(true)
      expect(second.chunkCount!).toBeGreaterThan(1)

      const files = await readdir(path.join(brainDir, "knowledge", "sources"))
      expect(files).toContain("sess-grow.md")
      expect(files.length).toBe(second.chunkCount)

      // The keyword moved to the transcript's tail — a query still finds it,
      // now via a later chunk rather than chunk 0.
      const query = await adapter.query({ query: "growkeyword" })
      expect(query.hits.length).toBeGreaterThan(0)
      expect(query.hits[0]!.sourceId).not.toBe("sess-grow")
    })

    it("reindex shrink: tombstones chunks the smaller re-ingest no longer produces (no ghost duplicates)", async () => {
      const tight = new IngestPipeline({
        workspace: "test-ws",
        readSession: () => readSessionImpl("sess-shrink"),
        state,
        getProvider,
        chunkMaxBytes: 150,
      })

      readSessionImpl = async () => longTranscript("Shrink session", 20, "zzzshrinkkeyword")
      const first = await tight.ingest("sess-shrink")
      expect(first.chunkCount!).toBeGreaterThan(1)
      expect(await adapter.query({ query: "zzzshrinkkeyword" }).then(r => r.hits.length)).toBeGreaterThan(0)

      readSessionImpl = async () => shortTranscript("Shrink session", "keptkeyword")
      const second = await tight.ingest("sess-shrink", true)
      expect(second.ok).toBe(true)
      expect(second.chunkCount).toBe(1)

      // The old tail chunk (still on disk from the first ingest) must no
      // longer be part of the index — otherwise it's a ghost duplicate that
      // never stops matching a keyword the session no longer contains.
      const stale = await adapter.query({ query: "zzzshrinkkeyword" })
      expect(stale.hits).toEqual([])

      const fresh = await adapter.query({ query: "keptkeyword" })
      expect(fresh.hits.length).toBeGreaterThan(0)

      // Bookkeeping reflects only the current (single) chunk.
      const recorded = await state.read()
      expect(recorded["sess-shrink"]!.sourceIds).toEqual(["sess-shrink"])
    })
  })
})
