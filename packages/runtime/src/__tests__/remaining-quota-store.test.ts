/**
 * Coverage for the best-effort remaining-quota store — round-trip persistence
 * against an injected temp `dir`, and the two "never throw on read" tolerances
 * (missing file, corrupt file).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RemainingQuota } from "../remaining-quota.js"
import {
  loadQuotaStore,
  readProfileQuota,
  recordProfileQuota,
  type StoredProfileQuota,
} from "../remaining-quota-store.js"

function quota(window: string, remaining: number): RemainingQuota {
  return { window, remaining, resetsAt: "2026-07-24T05:00:00.000Z", basis: "provider" }
}

describe("remaining-quota-store", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quota-store-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("round-trips record → read against an injected dir", async () => {
    const entry: StoredProfileQuota = {
      profileRef: "max",
      windows: { "5h": quota("5h", 100), "7d": quota("7d", 900) },
      fetchedAt: "2026-07-24T00:00:00.000Z",
    }
    await recordProfileQuota(entry, { dir })
    const read = await readProfileQuota("max", { dir })
    expect(read).toEqual(entry)
  })

  it("upserts by profileRef and preserves other profiles", async () => {
    await recordProfileQuota(
      { profileRef: "max", windows: { "5h": quota("5h", 10) }, fetchedAt: "t1" },
      { dir },
    )
    await recordProfileQuota(
      { profileRef: "team", windows: { "7d": quota("7d", 20) }, fetchedAt: "t2" },
      { dir },
    )
    await recordProfileQuota(
      { profileRef: "max", windows: { "5h": quota("5h", 5) }, fetchedAt: "t3" },
      { dir },
    )
    const store = await loadQuotaStore({ dir })
    expect(store.profiles.max?.windows["5h"]?.remaining).toBe(5)
    expect(store.profiles.team?.windows["7d"]?.remaining).toBe(20)
  })

  it("missing file → empty store (no throw)", async () => {
    const store = await loadQuotaStore({ dir })
    expect(store).toEqual({ version: 1, profiles: {} })
    expect(await readProfileQuota("nope", { dir })).toBeUndefined()
  })

  it("corrupt file → empty store (no throw)", async () => {
    await writeFile(join(dir, "usage-quota.json"), "{ not valid json ", "utf8")
    const store = await loadQuotaStore({ dir })
    expect(store).toEqual({ version: 1, profiles: {} })
    expect(await readProfileQuota("max", { dir })).toBeUndefined()
  })

  it("schema-mismatched file → empty store (no throw)", async () => {
    await writeFile(
      join(dir, "usage-quota.json"),
      JSON.stringify({ version: 2, profiles: {} }),
      "utf8",
    )
    const store = await loadQuotaStore({ dir })
    expect(store).toEqual({ version: 1, profiles: {} })
  })
})
