/**
 * Tests for {@link createBrainManager} — the orchestrator wiring persistence +
 * pipeline + a real queryable `FilesKnowledgeAdapter` behind one object.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createBrainManager, type BrainManager } from "../brain-manager.js"
import { createBrainState } from "../brain-state.js"
import { PIPELINE_VERSION } from "../pipeline-version.js"
import type { ExportedSessionLike } from "../types.js"

function transcript(title: string, body: string): ExportedSessionLike {
  return {
    meta: { title },
    messages: [
      { role: "user", text: "how do we ship?", ts: 1700000000000 },
      { role: "assistant", text: body, ts: 1700000001000 },
    ],
  }
}

describe("createBrainManager", () => {
  let brainDir: string
  let brain: BrainManager
  let sessionRefs: string[]

  beforeEach(async () => {
    brainDir = await mkdtemp(path.join(tmpdir(), "brain-manager-"))
    sessionRefs = ["sess-abc123"]
    brain = createBrainManager({
      workspace: "test-ws",
      brainDir,
      readSession: async ref =>
        ref === "sess-abc123"
          ? transcript("Ship it", "we cut a release with cargo cut")
          : null,
      listSessionRefs: async () => sessionRefs,
    })
  })

  afterEach(async () => {
    await rm(brainDir, { recursive: true, force: true })
  })

  it("ingests a session and reports it in status", async () => {
    const result = await brain.ingestSession("sess-abc123")
    expect(result.ok).toBe(true)
    expect(result.pipelineVersion).toBe(PIPELINE_VERSION)

    const status = await brain.status()
    expect(status.workspace).toBe("test-ws")
    expect(status.brainDir).toBe(brainDir)
    expect(status.sourceCount).toBe(1)
    expect(status.pendingSessions).toBe(0)
    expect(status.ready).toBe(true)
    expect(status.staleSources).toBe(0)
    expect(status.currentPipelineVersion).toBe(PIPELINE_VERSION)
  })

  it("reports a source ingested under an older pipeline version as stale in status", async () => {
    // Write a record directly, as if ingested before pipeline versioning
    // existed — status() must flag it rather than silently counting it as
    // current, since ingestPending's convergence would otherwise never
    // revisit it after a chunking/pipeline fix ships.
    const state = createBrainState(brainDir)
    await state.record({
      sessionId: "sess-legacy",
      sourceId: "sess-legacy",
      ingestedAt: "2020-01-01T00:00:00.000Z",
      turnCount: 1,
      bytes: 10,
    })

    const status = await brain.status()
    expect(status.sourceCount).toBe(1)
    expect(status.staleSources).toBe(1)
    expect(status.currentPipelineVersion).toBe(PIPELINE_VERSION)
  })

  it("ingestPending's reindexStale option clears a stale record and the staleSources count", async () => {
    const state = createBrainState(brainDir)
    await state.record({
      sessionId: "sess-abc123",
      sourceId: "sess-abc123",
      ingestedAt: "2020-01-01T00:00:00.000Z",
      turnCount: 1,
      bytes: 10,
    })
    expect((await brain.status()).staleSources).toBe(1)

    const report = await brain.ingestPending({ reindexStale: true })
    expect(report.staleSources).toBe(0)
    expect((await brain.status()).staleSources).toBe(0)
  })

  it("exposes a queryable provider over the ingested content", async () => {
    await brain.ingestSession("sess-abc123")
    const query = await brain.getProvider().query({ query: "cargo", topK: 5 })
    expect(query.hits.length).toBeGreaterThan(0)
    expect(query.hits[0]!.text).toContain("cargo")
  })

  it("computes pending sessions from listSessionRefs", async () => {
    sessionRefs = ["sess-abc123", "sess-new"]
    const status = await brain.status()
    expect(status.sourceCount).toBe(0)
    expect(status.pendingSessions).toBe(2)
  })

  it("persists across instances (state lives on disk)", async () => {
    await brain.ingestSession("sess-abc123")

    const second = createBrainManager({
      workspace: "test-ws",
      brainDir,
      readSession: async () => null,
      listSessionRefs: async () => sessionRefs,
    })
    const status = await second.status()
    expect(status.sourceCount).toBe(1)
  })

  it("records an unknown session as no-transcript", async () => {
    const result = await brain.ingestSession("sess-unknown")
    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe("no-transcript")
    expect((await brain.status()).sourceCount).toBe(0)
  })

  it("excludes a skipped session from pendingSessions and surfaces skippedSessions", async () => {
    sessionRefs = ["sess-abc123", "sess-bash-pty"]
    await brain.ingestSession("sess-abc123")
    await brain.ingestSession("sess-bash-pty") // readSession → null → skip

    const status = await brain.status()
    expect(status.sourceCount).toBe(1)
    expect(status.pendingSessions).toBe(0)
    expect(status.skippedSessions).toBe(1)
  })

  it("clears a skip once the same session later ingests successfully", async () => {
    sessionRefs = ["sess-abc123", "sess-flaky"]
    await brain.ingestSession("sess-flaky") // no reader entry → skip
    expect((await brain.status()).skippedSessions).toBe(1)

    const second = createBrainManager({
      workspace: "test-ws",
      brainDir,
      readSession: async () => transcript("Recovered", "now has a transcript"),
      listSessionRefs: async () => sessionRefs,
    })
    const result = await second.ingestSession("sess-flaky")
    expect(result.ok).toBe(true)

    const status = await second.status()
    expect(status.skippedSessions).toBe(0)
  })
})
