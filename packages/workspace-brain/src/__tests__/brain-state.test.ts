/**
 * `createBrainState` — concurrency safety of `record`/`forget` against ONE
 * instance. Regression coverage for a production incident: the debounced
 * exit subscriber (`workspace-brain-subscriber.ts`) fires one `ingest()` per
 * session exiting inside the same debounce batch, all against the same
 * `BrainState`, with no ordering between them. An unserialized
 * read-modify-write there raced on the write-tmp filename (unique only per
 * process, not per call) and corrupted a real `brain-state.json` — a valid
 * JSON body followed by a stray `}` from an interleaved write, which made
 * every read of the file degrade to "nothing ingested" per the corrupt-file
 * contract.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createBrainState } from "../brain-state.js"
import type { BrainStateRecord } from "../types.js"

function record(sessionId: string): BrainStateRecord {
  return {
    sessionId,
    sourceId: sessionId.replace("sess_", "sess-"),
    ingestedAt: new Date().toISOString(),
    turnCount: 1,
    bytes: 100,
  }
}

describe("createBrainState — concurrent record/forget", () => {
  let brainDir: string

  beforeEach(async () => {
    brainDir = await mkdtemp(path.join(tmpdir(), "brain-state-race-"))
  })

  afterEach(async () => {
    await rm(brainDir, { recursive: true, force: true })
  })

  it("persists every record from N concurrent record() calls, never corrupting the file", async () => {
    const state = createBrainState(brainDir)
    const N = 25

    await Promise.all(
      Array.from({ length: N }, (_, i) => state.record(record(`sess_${i}`))),
    )

    const ingested = await state.read()
    expect(Object.keys(ingested)).toHaveLength(N)
    for (let i = 0; i < N; i++) {
      expect(ingested[`sess_${i}`]?.sourceId).toBe(`sess-${i}`)
    }

    // The on-disk file must be valid JSON with no trailing garbage from an
    // interleaved write.
    const raw = await readFile(state.path, "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it("interleaves record() and forget() without losing or corrupting state", async () => {
    const state = createBrainState(brainDir)

    await Promise.all([
      state.record(record("sess_a")),
      state.record(record("sess_b")),
      state.record(record("sess_c")),
      state.forget("sess_a"),
      state.record(record("sess_d")),
    ])

    const raw = await readFile(state.path, "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()

    const ingested = await state.read()
    // sess_a's final state depends on ordering (record vs forget raced),
    // but b/c/d must all have landed — none of them raced against anything
    // but the shared queue.
    expect(ingested.sess_b).toBeDefined()
    expect(ingested.sess_c).toBeDefined()
    expect(ingested.sess_d).toBeDefined()
  })
})
