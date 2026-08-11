/**
 * Tests for {@link IngestPipeline} driven end-to-end through the REAL
 * `FilesKnowledgeAdapter` + `LocalFs` over a temp brain dir — so the "write a
 * source file under knowledge/sources/ and make it queryable" contract is
 * exercised for real, not stubbed.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
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
})
