/**
 * The provider-side orphan gc: which boxes a provider's control plane still
 * holds are ORPHANS, and how they are deleted.
 *
 * The rule is deliberately strict: a box is an orphan only when the daemon's
 * sandbox registry does not know it AND no live session holds it AND it is
 * past the grace window (15 minutes) AND the provider counts no attached
 * session on it. A box a live session holds is never a candidate, whatever
 * else is true of it.
 */

import { describe, it, expect } from "vitest"
import {
  collectProviderOrphanCandidates,
  liveSessionBoxIds,
  ORPHAN_GRACE_MS,
  reapSandboxOrphan,
  runSandboxOrphanGcPass,
  scanSandboxProviderOrphans,
} from "../sandbox-orphan-gc.js"
import type { SandboxGcProviderHandle } from "../sandbox-gc.js"

/** A box created long enough ago to be past the grace window. */
const OLD = "2026-10-21T09:00:00Z"
/** The clock the tests reason about. */
const NOW = Date.parse("2026-10-21T12:00:00Z")

function handleWith(
  boxes: Array<{ id: string; state?: string; sessions?: number; memoryMiB?: number; createdAt?: string }>,
  removed: Array<{ id: string; force: boolean | undefined }>,
  listError?: string,
): SandboxGcProviderHandle {
  return {
    provider: {
      listBoxes: async () => {
        if (listError !== undefined) throw new Error(listError)
        return boxes
      },
      remove: async (id: string, opts?: { force?: boolean }) => {
        removed.push({ id, force: opts?.force })
      },
    },
  }
}

describe("collectProviderOrphanCandidates", () => {
  it("proposes a box the registry does not know and no live session holds", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-1", state: "stopped", sessions: 0, memoryMiB: 4096, createdAt: OLD }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      provider: "computer",
      boxId: "cmp-1",
      state: "stopped",
      sessions: 0,
      memoryMiB: 4096,
    })
    expect(candidates[0]?.reason).toContain("no live session")
    expect(candidates[0]?.reason).toContain("grace window")
  })

  it("never proposes a box a live session holds", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-held", state: "running", sessions: 0, createdAt: OLD }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(["cmp-held"]),
      now: NOW,
    })
    expect(candidates).toEqual([])
  })

  it("never proposes a box the daemon registry knows (the ledger gc owns it)", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-known", state: "stopped", createdAt: OLD }],
      registryBoxIds: new Set(["cmp-known"]),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates).toEqual([])
  })

  it("reports the age when the provider knows the creation time", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-1", sessions: 0, createdAt: OLD }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates[0]?.ageMs).toBe(3 * 60 * 60 * 1000)
  })

  it("never proposes a box the provider still counts a session on", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-attached", state: "running", sessions: 1, createdAt: OLD }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates).toEqual([])
  })

  it("proposes an attached box only with includeAttached", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-attached", state: "running", sessions: 1, createdAt: OLD }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      includeAttached: true,
      now: NOW,
    })
    expect(candidates.map(c => c.boxId)).toEqual(["cmp-attached"])
    expect(candidates[0]?.reason).toContain("attached session")
  })

  it("never proposes a box younger than the grace window", () => {
    const fresh = new Date(NOW - ORPHAN_GRACE_MS + 60_000).toISOString()
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-fresh", state: "stopped", sessions: 0, createdAt: fresh }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates).toEqual([])
  })

  it("never proposes a box the provider does not date (the grace window cannot be proven)", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-undated", state: "stopped", sessions: 0 }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates).toEqual([])
  })
})

describe("liveSessionBoxIds", () => {
  it("counts a box held by a running session and skips a dead session's box", () => {
    const ids = liveSessionBoxIds([
      { id: "a", status: "running", sandboxId: "cmp-live" },
      { id: "b", status: "error", sandboxId: "cmp-dead" },
      { id: "c", status: "idle", sandboxId: "cmp-idle" },
      { id: "d", status: "running" },
    ])
    expect([...ids].sort()).toEqual(["cmp-idle", "cmp-live"])
  })
})

describe("scanSandboxProviderOrphans", () => {
  it("keeps a broken provider from stopping the others", async () => {
    const removed: Array<{ id: string; force: boolean | undefined }> = []
    const scans = await scanSandboxProviderOrphans({
      resolveProvider: async slug =>
        slug === "broken"
          ? handleWith([], removed, "computer controller unreachable at http://ctrl:7110")
          : handleWith([{ id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: OLD }], removed),
      providerSlugs: ["broken", "healthy"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(scans.find(s => s.provider === "broken")?.error).toContain("computer controller unreachable")
    expect(scans.find(s => s.provider === "healthy")?.candidates.map(c => c.boxId)).toEqual([
      "cmp-orphan",
    ])
    // The broken provider was NOT enumerated: it says so, it does not claim
    // an empty (clean) sweep.
    expect(scans.find(s => s.provider === "broken")?.scanned).toBe(false)
    expect(scans.find(s => s.provider === "healthy")?.scanned).toBe(true)
  })

  it("reports a provider it cannot enumerate as not scanned", async () => {
    const scans = await scanSandboxProviderOrphans({
      resolveProvider: async () => ({ provider: {} }),
      providerSlugs: ["plain"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
    })
    expect(scans).toHaveLength(1)
    expect(scans[0]?.scanned).toBe(false)
    expect(scans[0]?.candidates).toEqual([])
  })

  it("reports an unconfigured provider as not scanned, without an error", async () => {
    const removed: Array<{ id: string; force: boolean | undefined }> = []
    const scans = await scanSandboxProviderOrphans({
      resolveProvider: async () =>
        handleWith([], removed, "computer sandbox: missing controllerUrl (config or COMPUTER_CONTROLLER_URL env)"),
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
    })
    expect(scans[0]?.scanned).toBe(false)
    expect(scans[0]?.error).toBeUndefined()
  })
})

describe("reapSandboxOrphan", () => {
  it("deletes the box with force=true", async () => {
    const removed: Array<{ id: string; force: boolean | undefined }> = []
    const res = await reapSandboxOrphan(
      {
        provider: "computer",
        boxId: "cmp-orphan",
        state: "stopped",
        reason: "orphan",
      },
      { resolveProvider: async () => handleWith([], removed) },
    )
    expect(res).toEqual({ ok: true })
    expect(removed).toEqual([{ id: "cmp-orphan", force: true }])
  })

  it("treats an already-gone box (404) as success", async () => {
    const res = await reapSandboxOrphan(
      { provider: "computer", boxId: "cmp-gone", state: "stopped", reason: "orphan" },
      {
        resolveProvider: async () => ({
          provider: {
            remove: async () => {
              throw new Error("computer controller 404 on DELETE /v1/computers/cmp-gone: not found")
            },
          },
        }),
      },
    )
    expect(res).toEqual({ ok: true })
  })

  it("treats the typed gone sentinel as success", async () => {
    const res = await reapSandboxOrphan(
      { provider: "computer", boxId: "cmp-gone", state: "stopped", reason: "orphan" },
      {
        resolveProvider: async () => ({
          provider: {
            remove: async () => {
              const err = new Error("box cmp-gone is gone")
              err.name = "SandboxBoxGoneError"
              throw err
            },
          },
        }),
      },
    )
    expect(res).toEqual({ ok: true })
  })

  it("does NOT treat an unrelated 'not found' as a successful reap", async () => {
    const res = await reapSandboxOrphan(
      { provider: "computer", boxId: "cmp-x", state: "stopped", reason: "orphan" },
      {
        resolveProvider: async () => ({
          provider: {
            remove: async () => {
              throw new Error('provider "computer" not found')
            },
          },
        }),
      },
    )
    expect(res.ok).toBe(false)
  })

  it("reports a failed delete", async () => {
    const res = await reapSandboxOrphan(
      { provider: "computer", boxId: "cmp-x", state: "stopped", reason: "orphan" },
      {
        resolveProvider: async () => ({
          provider: {
            remove: async () => {
              throw new Error("computer controller 500 on DELETE /v1/computers/cmp-x")
            },
          },
        }),
      },
    )
    expect(res.ok).toBe(false)
  })
})

describe("runSandboxOrphanGcPass", () => {
  it("lists the orphans without deleting them (dry run)", async () => {
    const removed: Array<{ id: string; force: boolean | undefined }> = []
    const pass = await runSandboxOrphanGcPass({
      resolveProvider: async () =>
        handleWith([{ id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: OLD }], removed),
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(pass.candidates.map(c => c.boxId)).toEqual(["cmp-orphan"])
    expect(removed).toEqual([])
    expect(pass.deleted).toEqual([])
    expect(pass.scanned).toBe(true)
  })

  it("deletes the orphans with apply", async () => {
    const removed: Array<{ id: string; force: boolean | undefined }> = []
    const pass = await runSandboxOrphanGcPass({
      resolveProvider: async () =>
        handleWith([{ id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: OLD }], removed),
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
      apply: true,
    })
    expect(pass.deleted).toEqual(["cmp-orphan"])
    expect(removed).toEqual([{ id: "cmp-orphan", force: true }])
  })

  it("says it did not scan when no provider could be enumerated", async () => {
    const pass = await runSandboxOrphanGcPass({
      resolveProvider: async () => null,
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(pass.scanned).toBe(false)
    expect(pass.candidates).toEqual([])
    expect(pass.notScanned.map(s => s.provider)).toEqual(["computer"])
  })
})
