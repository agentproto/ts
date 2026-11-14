/**
 * `readUsageSnapshots` on a read that fails mid-stream: the records parsed
 * before the error come back, the read never throws (E99 review).
 */
import { Readable } from "node:stream"
import { describe, expect, it, vi } from "vitest"

const snapshot = (ts: string) => JSON.stringify({ kind: "usage_snapshot", ts, source: "adapter", costUsd: 0.1 })

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    open: vi.fn(async () => ({
      createReadStream: () =>
        Readable.from(
          (async function* () {
            yield `${snapshot("2026-11-02T01:00:00.000Z")}\n${snapshot("2026-11-02T02:00:00.000Z")}\n`
            throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" })
          })(),
        ),
      close: async () => {},
    })),
  }
})

describe("readUsageSnapshots on a mid-stream read error", () => {
  it("returns the records parsed before the error", async () => {
    const { readUsageSnapshots } = await import("../usage-snapshot-log.js")
    const records = await readUsageSnapshots("sess_eio", "/nonexistent-base")
    expect(records.map(r => r.ts)).toEqual(["2026-11-02T01:00:00.000Z", "2026-11-02T02:00:00.000Z"])
  })
})
