/**
 * The provider-side orphan gc: which boxes a provider's control plane still
 * holds are ORPHANS, and how they are deleted.
 *
 * The rule is deliberately strict: a box is an orphan only when the daemon's
 * sandbox registry does not know it AND no live session holds it AND it is
 * older than the grace window AND the provider reports no attached session
 * for it. A box held by a live session is never a candidate, whatever else
 * is true of it, and a box the provider still counts a session for (the
 * shape a box of ANOTHER daemon on the shared tenant has) is only ever a
 * candidate with the explicit opt-in.
 */

import { describe, it, expect } from "vitest"
import {
  collectProviderOrphanCandidates,
  DEFAULT_ORPHAN_MIN_AGE_MS,
  liveSessionBoxIds,
  reapSandboxOrphan,
  runSandboxOrphanGcPass,
  scanSandboxProviderOrphans,
} from "../sandbox-orphan-gc.js"
import type { SandboxGcProviderHandle } from "../sandbox-gc.js"

/** The clock every age is measured against. */
const NOW = Date.parse("2026-10-21T12:00:00Z")
/** A box created three hours before NOW - well outside the grace window. */
const OLD = "2026-10-21T09:00:00Z"
/** A box created one minute before NOW - inside the grace window. */
const FRESH = "2026-10-21T11:59:00Z"

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
      boxes: [{ id: "cmp-known", state: "stopped", sessions: 0, createdAt: OLD }],
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

  it("never proposes a box whose age the provider does not report", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-unknown-age", state: "stopped", sessions: 0 }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates).toEqual([])
  })

  it("never proposes a box inside the grace window (an in-flight boot)", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-fresh", state: "running", sessions: 0, createdAt: FRESH }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates).toEqual([])
  })

  it("proposes a box that just left the grace window", () => {
    const justOld = new Date(NOW - DEFAULT_ORPHAN_MIN_AGE_MS).toISOString()
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-aged", state: "running", sessions: 0, createdAt: justOld }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates.map(c => c.boxId)).toEqual(["cmp-aged"])
  })

  it("never proposes a box the provider still counts a session for", () => {
    // The shared-tenant shape: the box belongs to ANOTHER daemon, so this
    // daemon's ledger and live sessions know nothing about it - but the
    // controller counts its session slot.
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-other-daemon", state: "running", sessions: 1, createdAt: OLD }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates).toEqual([])
  })

  it("never proposes a box whose session count the provider does not report", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-unknown-sessions", state: "running", createdAt: OLD }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
    })
    expect(candidates).toEqual([])
  })

  it("proposes an attached box only with the explicit opt-in", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [{ id: "cmp-other-daemon", state: "running", sessions: 1, createdAt: OLD }],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      includeAttached: true,
      now: NOW,
    })
    expect(candidates.map(c => c.boxId)).toEqual(["cmp-other-daemon"])
    expect(candidates[0]?.reason).toContain("attached")
  })

  it("the opt-in never bypasses the grace window or the live-session rule", () => {
    const candidates = collectProviderOrphanCandidates({
      provider: "computer",
      boxes: [
        { id: "cmp-fresh", state: "running", sessions: 1, createdAt: FRESH },
        { id: "cmp-held", state: "running", sessions: 1, createdAt: OLD },
      ],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(["cmp-held"]),
      includeAttached: true,
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
  })

  it("says a provider it could not list was not scanned", async () => {
    const scans = await scanSandboxProviderOrphans({
      resolveProvider: async () => ({ provider: {} }),
      providerSlugs: ["plain"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
    })
    expect(scans).toHaveLength(1)
    expect(scans[0]?.scanned).toBe(false)
    expect(scans[0]?.skipped).toContain("cannot list")
  })

  it("says an unconfigured provider was not scanned", async () => {
    const scans = await scanSandboxProviderOrphans({
      resolveProvider: async () => null,
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
    })
    expect(scans[0]?.scanned).toBe(false)
    expect(scans[0]?.skipped).toContain("not configured")
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

  it("does NOT treat a bare 'provider not found' error as a gone box", async () => {
    // The provider itself is missing - the box (and its RAM) is still
    // there. Stamping that as a successful reap would hide the box.
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
    expect(res.ok === false && res.error).toContain("not found")
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

  it("does not delete an attached box without the opt-in", async () => {
    const removed: Array<{ id: string; force: boolean | undefined }> = []
    const pass = await runSandboxOrphanGcPass({
      resolveProvider: async () =>
        handleWith([{ id: "cmp-other", state: "running", sessions: 1, createdAt: OLD }], removed),
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
      apply: true,
    })
    expect(pass.candidates).toEqual([])
    expect(removed).toEqual([])
  })

  it("deletes an attached box with the opt-in", async () => {
    const removed: Array<{ id: string; force: boolean | undefined }> = []
    const pass = await runSandboxOrphanGcPass({
      resolveProvider: async () =>
        handleWith([{ id: "cmp-other", state: "running", sessions: 1, createdAt: OLD }], removed),
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
      now: NOW,
      includeAttached: true,
      apply: true,
    })
    expect(pass.deleted).toEqual(["cmp-other"])
    expect(removed).toEqual([{ id: "cmp-other", force: true }])
  })

  it("reports that no provider was scanned", async () => {
    const pass = await runSandboxOrphanGcPass({
      resolveProvider: async () => null,
      providerSlugs: ["computer"],
      registryBoxIds: new Set(),
      liveBoxIds: new Set(),
    })
    expect(pass.scanned).toBe(false)
    expect(pass.candidates).toEqual([])
  })
})
