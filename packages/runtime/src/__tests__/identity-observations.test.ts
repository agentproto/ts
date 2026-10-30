/**
 * The persisted caller-identity totals (ts#2165 step 5): the pure arithmetic,
 * the file format and the tolerant reader behind `GET /identity`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  addIdentityTotals,
  emptyClaimOnlyClasses,
  emptyIdentityCounters,
  emptyIdentityTotals,
  loadIdentityObservations,
  saveIdentityObservations,
  IDENTITY_BOOTS_MAX,
  IDENTITY_ROUTES_MAX,
  type IdentityCounters,
  type IdentityObservationsFile,
  type IdentityTotals,
} from "../identity-observations.js"

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "identity-observations-"))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

function counters(overrides: Partial<IdentityCounters> = {}): IdentityCounters {
  return { ...emptyIdentityCounters(), ...overrides }
}

function totals(overrides: Partial<IdentityTotals> = {}): IdentityTotals {
  return {
    counters: counters(),
    refused: counters(),
    byRoute: {},
    claimOnlyByClass: emptyClaimOnlyClasses(),
    ...overrides,
  }
}

function writeFile(body: unknown): string {
  const path = join(tmp, "identity-observations.json")
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body))
  return path
}

describe("identity totals arithmetic", () => {
  it("addIdentityTotals sums counters, refused and claimOnlyByClass and unions byRoute", () => {
    const a = totals({
      counters: counters({ verified: 1, anonymous: 2 }),
      refused: counters({ claim_only: 1 }),
      byRoute: { mcp: counters({ verified: 1 }), sessions: counters({ claim_only: 1 }) },
      claimOnlyByClass: { external: 0, delivered: 1, undelivered: 0, unknown: 0 },
    })
    const b = totals({
      counters: counters({ verified: 3, anonymous: 4 }),
      refused: counters({ claim_only: 2, mismatch: 1 }),
      byRoute: { mcp: counters({ verified: 3 }), other: counters({ anonymous: 4 }) },
      claimOnlyByClass: { external: 1, delivered: 0, undelivered: 2, unknown: 0 },
    })
    const sum = addIdentityTotals(a, b)
    expect(sum.counters).toEqual(counters({ verified: 4, anonymous: 6 }))
    expect(sum.refused).toEqual(counters({ claim_only: 3, mismatch: 1 }))
    expect(sum.byRoute).toEqual({
      mcp: counters({ verified: 4 }),
      sessions: counters({ claim_only: 1 }),
      other: counters({ anonymous: 4 }),
    })
    expect(sum.claimOnlyByClass).toEqual({ external: 1, delivered: 1, undelivered: 2, unknown: 0 })
  })

  it("addIdentityTotals does not change its arguments", () => {
    const a = totals({ counters: counters({ verified: 1 }), byRoute: { mcp: counters({ verified: 1 }) } })
    const b = totals({ counters: counters({ verified: 2 }), byRoute: { mcp: counters({ verified: 2 }) } })
    const snapshotA = JSON.parse(JSON.stringify(a))
    const snapshotB = JSON.parse(JSON.stringify(b))
    addIdentityTotals(a, b)
    expect(a).toEqual(snapshotA)
    expect(b).toEqual(snapshotB)
  })

  it("emptyIdentityTotals is all zeros", () => {
    expect(emptyIdentityTotals()).toEqual({
      counters: { verified: 0, mismatch: 0, invalid_token: 0, claim_only: 0, anonymous: 0 },
      refused: { verified: 0, mismatch: 0, invalid_token: 0, claim_only: 0, anonymous: 0 },
      byRoute: {},
      claimOnlyByClass: { external: 0, delivered: 0, undelivered: 0, unknown: 0 },
    })
  })
})

describe("identity observations file", () => {
  it("save then load round-trips", () => {
    const path = join(tmp, "nested", "identity-observations.json")
    const file: IdentityObservationsFile = {
      version: 1,
      since: "2026-01-01T00:00:00.000Z",
      totals: totals({
        counters: counters({ verified: 5 }),
        byRoute: { mcp: counters({ verified: 5 }) },
        claimOnlyByClass: { external: 0, delivered: 2, undelivered: 0, unknown: 0 },
      }),
      boots: [{ at: "2026-01-01T00:00:00.000Z", build: "abc123" }],
    }
    saveIdentityObservations(path, file)
    expect(loadIdentityObservations(path)).toEqual(file)
  })

  it("load returns undefined for a missing file, invalid JSON, version 2 and a missing since", () => {
    expect(loadIdentityObservations(join(tmp, "absent.json"))).toBeUndefined()
    expect(loadIdentityObservations(writeFile("{not json"))).toBeUndefined()
    expect(loadIdentityObservations(writeFile({ version: 2, since: "2026-01-01T00:00:00.000Z", totals: totals(), boots: [] }))).toBeUndefined()
    expect(loadIdentityObservations(writeFile({ version: 1, totals: totals(), boots: [] }))).toBeUndefined()
    expect(loadIdentityObservations(writeFile({ version: 1, since: "", totals: totals(), boots: [] }))).toBeUndefined()
  })

  it("load turns a negative, NaN-as-string or non-number counter into 0 and drops unknown keys", () => {
    const path = writeFile({
      version: 1,
      since: "2026-01-01T00:00:00.000Z",
      totals: {
        counters: { verified: "NaN", mismatch: -1, invalid_token: "5", claim_only: null, anonymous: 3, audit: 9 },
        refused: { verified: -4, mismatch: 7 },
        byRoute: { mcp: { verified: -2, anonymous: "x", mystery: 1 }, "/health": { anonymous: true } },
        claimOnlyByClass: { external: "nope", delivered: 4, extra: 1 },
      },
      boots: [],
    })
    const loaded = loadIdentityObservations(path)
    expect(loaded).toBeDefined()
    expect(loaded?.totals.counters).toEqual(counters({ anonymous: 3 }))
    expect(loaded?.totals.refused).toEqual(counters({ mismatch: 7 }))
    expect(loaded?.totals.byRoute).toEqual({ mcp: counters(), "/health": counters() })
    expect(loaded?.totals.claimOnlyByClass).toEqual({ external: 0, delivered: 4, undelivered: 0, unknown: 0 })
  })

  it("load keeps only the last IDENTITY_BOOTS_MAX boots and drops a boot without at", () => {
    const boots: unknown[] = []
    for (let i = 0; i < IDENTITY_BOOTS_MAX + 5; i++) {
      boots.push({ at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, build: `sha-${i}` })
    }
    boots.splice(3, 0, { build: "no-at" })
    const path = writeFile({
      version: 1,
      since: "2026-01-01T00:00:00.000Z",
      totals: totals(),
      boots,
    })
    const loaded = loadIdentityObservations(path)
    expect(loaded?.boots).toHaveLength(IDENTITY_BOOTS_MAX)
    expect(loaded?.boots.every(b => typeof b.at === "string")).toBe(true)
    expect(loaded?.boots[IDENTITY_BOOTS_MAX - 1]?.build).toBe(`sha-${IDENTITY_BOOTS_MAX + 4}`)
    expect(loaded?.boots.some(b => b.build === "no-at")).toBe(false)
  })

  it("load keeps at most IDENTITY_ROUTES_MAX route keys", () => {
    const byRoute: Record<string, unknown> = {}
    for (let i = 0; i < IDENTITY_ROUTES_MAX + 8; i++) byRoute[`/route-${i}`] = { anonymous: 1 }
    const path = writeFile({
      version: 1,
      since: "2026-01-01T00:00:00.000Z",
      totals: { counters: {}, refused: {}, byRoute, claimOnlyByClass: {} },
      boots: [],
    })
    const loaded = loadIdentityObservations(path)
    expect(Object.keys(loaded?.totals.byRoute ?? {})).toHaveLength(IDENTITY_ROUTES_MAX)
    expect(loaded?.totals.byRoute["/route-0"]).toBeDefined()
    expect(loaded?.totals.byRoute[`/route-${IDENTITY_ROUTES_MAX}`]).toBeUndefined()
  })

  it("after a save no *.tmp file is left in the directory", () => {
    const path = join(tmp, "identity-observations.json")
    saveIdentityObservations(path, {
      version: 1,
      since: "2026-01-01T00:00:00.000Z",
      totals: totals(),
      boots: [],
    })
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8")).toContain('"version": 1')
    expect(readdirSync(tmp).filter(name => name.endsWith(".tmp"))).toEqual([])
  })

  it("save into a path whose parent is a regular file does not throw and warns once", () => {
    const parent = join(tmp, "not-a-dir")
    writeFileSync(parent, "keep me")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(() =>
      saveIdentityObservations(join(parent, "identity-observations.json"), {
        version: 1,
        since: "2026-01-01T00:00:00.000Z",
        totals: totals(),
        boots: [],
      }),
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(join(parent, "identity-observations.json"))
  })
})
