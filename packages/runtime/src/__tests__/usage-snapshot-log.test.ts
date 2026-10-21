/**
 * The durable `usage_snapshot` reader (`usage-snapshot-log.ts`) — the
 * on-disk half of the cache split.
 *
 * The WRITER (`transcript-writer.ts`'s `recordUsageSnapshot`) already records
 * `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` on every
 * snapshot that carries them (claude-code's transcript reader, hermes'
 * state.db, opencode.db). This reader used to drop them on the floor, so
 * every consumer of the durable path (the `usage_rollup` tool / service)
 * saw a cache-less session. These tests pin the projection: the split comes
 * back, and a snapshot that never had one keeps the field ABSENT — never a
 * measured 0.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readUsageSnapshots } from "../usage-snapshot-log.js"
import { sessionEventsPath } from "../transcript-writer.js"

const dirs: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Write an events.jsonl for `sessionId` with the given `usage_snapshot`
 *  records (plus whatever else the caller wants in the file). */
async function writeEvents(
  sessionId: string,
  baseDir: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  const dir = join(baseDir, sessionId)
  await mkdir(dir, { recursive: true })
  const lines = records.map((r, i) => JSON.stringify({ seq: i, ts: "2026-07-24T12:00:00.000Z", ...r }))
  await writeFile(sessionEventsPath(sessionId, baseDir), `${lines.join("\n")}\n`, "utf8")
}

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "usage-snapshot-log-test-"))
  dirs.push(dir)
  return dir
}

describe("readUsageSnapshots", () => {
  it("projects the cache split off the durable record", async () => {
    const baseDir = await tmpDir()
    await writeEvents("sess_a", baseDir, [
      {
        kind: "usage_snapshot",
        sessionId: "sess_a",
        model: "claude-sonnet-4-5",
        costUsd: 0.42,
        tokensIn: 1_000,
        tokensOut: 500,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 3_000,
        reasoningTokens: 128,
        source: "adapter",
      },
    ])

    const records = await readUsageSnapshots("sess_a", baseDir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      costUsd: 0.42,
      tokensIn: 1_000,
      tokensOut: 500,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 3_000,
      reasoningTokens: 128,
      source: "adapter",
    })
  })

  it("a snapshot without the split keeps the fields ABSENT, never 0", async () => {
    const baseDir = await tmpDir()
    await writeEvents("sess_b", baseDir, [
      {
        kind: "usage_snapshot",
        sessionId: "sess_b",
        costUsd: 0.01,
        tokensIn: 10,
        tokensOut: 5,
        source: "computed",
      },
    ])

    const records = await readUsageSnapshots("sess_b", baseDir)
    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.cacheReadTokens).toBeUndefined()
    expect(rec.cacheWriteTokens).toBeUndefined()
    expect(rec.reasoningTokens).toBeUndefined()
    expect("cacheReadTokens" in rec).toBe(false)
    expect("reasoningTokens" in rec).toBe(false)
  })

  it("skips non-snapshot records and malformed lines, and never throws on a missing file", async () => {
    const baseDir = await tmpDir()
    await writeEvents("sess_c", baseDir, [
      { kind: "turn-end", reason: "done" },
      { kind: "usage_snapshot", sessionId: "sess_c", costUsd: 0.02, source: "adapter" },
    ])
    // A malformed line appended after the good ones.
    const path = sessionEventsPath("sess_c", baseDir)
    const { appendFile } = await import("node:fs/promises")
    await appendFile(path, "{not json\n", "utf8")

    const records = await readUsageSnapshots("sess_c", baseDir)
    expect(records).toHaveLength(1)
    expect(records[0]?.costUsd).toBe(0.02)

    // Missing file → empty, no throw.
    await expect(readUsageSnapshots("sess_missing", baseDir)).resolves.toEqual([])
  })
})
