/**
 * The provider-side orphan gc: which boxes a provider's control plane still
 * holds are ORPHANS, and how they are deleted.
 *
 * The rule is deliberately strict: a box is an orphan only when the daemon's
 * sandbox registry does not know it AND no live session holds it. A box a
 * live session holds is never a candidate, whatever else is true of it.
 */

import { describe, it, expect } from "vitest"
import {
  collectProviderOrphanCandidates,
  liveSessionBoxIds,
  reapSandboxOrphan,
  runSandboxOrphanGcPass,
  scanSandboxProviderOrphans,
} from "../sandbox-orphan-gc.js"
import type { SandboxGcProviderHandle } from "../sandbox-gc.js"

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
      boxes: [{ id: "cmp-1", state: "stopped", sessions: 1, memoryMiB: 4096 }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: Date.parse("2026-10-21T12:00:00Z"),
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      provider: "computer",
      boxId: "cmp-1",
      state: "stopped",
      sessions: 1,
      memoryMiB: 4096,
    })
    expect(candidates[0]?.reason).toContain("no live session")
  })

  it("never proposes a box a live session holds", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-held", state: "running" }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(["cmp-held"]),
    })
    expect(candidates).toEqual([])
  })

  it("never proposes a box the daemon registry knows (the ledger gc owns it)", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-known", state: "stopped" }],
      registryBoxIds: new Set(["cmp-known"]),
      liveBoxIds: new Set(),
    })
    expect(candidates).toEqual([])
  })

  it("reports the age when the provider knows the creation time", () => {
    const now = Date.parse("2026-10-21T12:00:00Z")
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-1", createdAt: "2026-10-21T09:00:00Z" }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now,
    })
    expect(candidates[0]?.ageMs).toBe(3 * 60 * 60 * 1000)
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
          : handleWith([{ id: "cmp-orphan", state: "stopped" }], removed),
      providerSlugs: ["broken", "healthy"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
    })
    expect(scans.find(s => s.provider === "broken")?.error).toContain("computer controller unreachable")
    expect(scans.find(s => s.provider === "healthy")?.candidates.map(c => c.boxId)).toEqual([
      "cmp-orphan",
    ])
  })

  it("ignores a provider that cannot enumerate its boxes", async () => {
    const scans = await scanSandboxProviderOrphans({
      resolveProvider: async () => ({ provider: {} }),
      providerSlugs: ["plain"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
    })
    expect(scans).toEqual([])
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

  it("treats an already-gone box as success", async () => {
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
      resolveProvider: async () => handleWith([{ id: "cmp-orphan", state: "stopped" }], removed),
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
    })
    expect(pass.candidates.map(c => c.boxId)).toEqual(["cmp-orphan"])
    expect(removed).toEqual([])
    expect(pass.deleted).toEqual([])
  })

  it("deletes the orphans with apply", async () => {
    const removed: Array<{ id: string; force: boolean | undefined }> = []
    const pass = await runSandboxOrphanGcPass({
      resolveProvider: async () => handleWith([{ id: "cmp-orphan", state: "stopped" }], removed),
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      apply: true,
    })
    expect(pass.deleted).toEqual(["cmp-orphan"])
    expect(removed).toEqual([{ id: "cmp-orphan", force: true }])
  })
})
