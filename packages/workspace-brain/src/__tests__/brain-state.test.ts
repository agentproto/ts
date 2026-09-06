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

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { brainStatePath, createBrainState } from "../brain-state.js"
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

describe("createBrainState — skips", () => {
  let brainDir: string

  beforeEach(async () => {
    brainDir = await mkdtemp(path.join(tmpdir(), "brain-state-skips-"))
  })

  afterEach(async () => {
    await rm(brainDir, { recursive: true, force: true })
  })

  it("records a skip and persists it across instances", async () => {
    const state = createBrainState(brainDir)
    await state.recordSkip("sess_gone", "no-transcript")

    const skips = await state.readSkips()
    expect(skips.sess_gone).toMatchObject({ sessionId: "sess_gone", reason: "no-transcript" })
    expect(typeof skips.sess_gone?.skippedAt).toBe("string")

    const raw = await readFile(state.path, "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()

    const second = createBrainState(brainDir)
    expect((await second.readSkips()).sess_gone).toBeDefined()
  })

  it("does not count a skip as ingested", async () => {
    const state = createBrainState(brainDir)
    await state.recordSkip("sess_gone", "empty-transcript")
    expect(await state.read()).toEqual({})
  })

  it("clears a skip when the same session is later successfully recorded", async () => {
    const state = createBrainState(brainDir)
    await state.recordSkip("sess_a", "no-transcript")
    expect((await state.readSkips()).sess_a).toBeDefined()

    await state.record(record("sess_a"))
    expect((await state.readSkips()).sess_a).toBeUndefined()
    expect((await state.read()).sess_a).toBeDefined()
  })

  it("parses a legacy state file with no `skips` field as empty skips", async () => {
    const legacy = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ingested: { sess_x: record("sess_x") },
    }
    await writeFile(brainStatePath(brainDir), JSON.stringify(legacy), "utf8")

    const state = createBrainState(brainDir)
    expect(await state.readSkips()).toEqual({})
    expect((await state.read()).sess_x).toBeDefined()
  })

  it("persists every skip from N concurrent recordSkip() calls, never corrupting the file", async () => {
    const state = createBrainState(brainDir)
    const N = 25

    await Promise.all(
      Array.from({ length: N }, (_, i) => state.recordSkip(`sess_${i}`, "no-transcript")),
    )

    const skips = await state.readSkips()
    expect(Object.keys(skips)).toHaveLength(N)

    const raw = await readFile(state.path, "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it("interleaves recordSkip() and record() without losing or corrupting state", async () => {
    const state = createBrainState(brainDir)

    await Promise.all([
      state.recordSkip("sess_a", "no-transcript"),
      state.record(record("sess_b")),
      state.recordSkip("sess_c", "empty-transcript"),
      state.record(record("sess_d")),
    ])

    const raw = await readFile(state.path, "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()

    const ingested = await state.read()
    const skips = await state.readSkips()
    expect(ingested.sess_b).toBeDefined()
    expect(ingested.sess_d).toBeDefined()
    expect(skips.sess_a).toBeDefined()
    expect(skips.sess_c).toBeDefined()
  })
})
