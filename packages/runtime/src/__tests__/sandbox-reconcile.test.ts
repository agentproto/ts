/**
 * `reconcileSandboxLedger` — closes the gap between the ledger's belief
 * ("~50 boxes paused/booted") and provider reality (far fewer) by probing
 * every ledger row still claiming to be alive and stamping the verdict back
 * (never tearing a box down — read-only against the provider, and a "gone"
 * verdict only ever flips the ledger row's `state`, never removes it).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { reconcileSandboxLedger, type SandboxReconcileProviderHandle } from "../sandbox-reconcile.js"
import { readSandboxLedger, recordSandboxBoot, type SandboxLedgerEntry } from "../sandbox-ledger.js"

const tmps: string[] = []
afterEach(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const newLedgerPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-reconcile-"))
  tmps.push(dir)
  return join(dir, "sandboxes.json")
}

const entry = (overrides: Partial<SandboxLedgerEntry>): SandboxLedgerEntry => ({
  sandboxId: "bx_abc123",
  provider: "box",
  state: "paused",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  ...overrides,
})

describe("reconcileSandboxLedger", () => {
  it("flips a row the provider reports gone, via the injected recordLiveness", async () => {
    const entries = [entry({})]
    const recordLiveness = vi.fn()
    const probe = vi.fn(async () => ({ alive: false }))
    const resolveProvider = vi.fn(
      async (): Promise<SandboxReconcileProviderHandle> => ({ provider: { probe } }),
    )
    const result = await reconcileSandboxLedger({
      resolveProvider,
      readLedger: () => entries,
      recordLiveness,
    })
    expect(probe).toHaveBeenCalledWith("bx_abc123")
    expect(recordLiveness).toHaveBeenCalledWith("bx_abc123", false, undefined)
    expect(result).toEqual({
      checked: 1,
      alive: 0,
      gone: 1,
      unknown: 0,
      skipped: 0,
      rows: [{ sandboxId: "bx_abc123", provider: "box", verdict: "gone" }],
    })
  })

  it("leaves a live row alone besides re-stamping sandboxAlive:true", async () => {
    const entries = [entry({ state: "booted" })]
    const recordLiveness = vi.fn()
    const probe = vi.fn(async () => ({ alive: true, state: "running" }))
    const result = await reconcileSandboxLedger({
      resolveProvider: async () => ({ provider: { probe } }),
      readLedger: () => entries,
      recordLiveness,
    })
    expect(recordLiveness).toHaveBeenCalledWith("bx_abc123", true, undefined)
    expect(result.alive).toBe(1)
    expect(result.gone).toBe(0)
  })

  it("never deletes a row and never calls stop/pause/connect — the provider handle it needs is probe-only", async () => {
    const entries = [entry({})]
    const probe = vi.fn(async () => ({ alive: false }))
    // The handle type accepted here has no stop/pause/connect at all —
    // structurally verifies reconcile can't reach for them.
    const handle: SandboxReconcileProviderHandle = { provider: { probe } }
    await reconcileSandboxLedger({
      resolveProvider: async () => handle,
      readLedger: () => entries,
      recordLiveness: vi.fn(),
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("skips (never treats as dead) a provider with no probe()", async () => {
    const entries = [entry({})]
    const recordLiveness = vi.fn()
    const result = await reconcileSandboxLedger({
      resolveProvider: async () => ({ provider: {} }),
      readLedger: () => entries,
      recordLiveness,
    })
    expect(recordLiveness).not.toHaveBeenCalled()
    expect(result).toEqual({
      checked: 1,
      alive: 0,
      gone: 0,
      unknown: 0,
      skipped: 1,
      rows: [{ sandboxId: "bx_abc123", provider: "box", verdict: "skipped" }],
    })
  })

  it("a resolveProvider failure is 'unknown', never 'gone' — a broken credential must not orphan a live box", async () => {
    const entries = [entry({})]
    const recordLiveness = vi.fn()
    const result = await reconcileSandboxLedger({
      resolveProvider: async () => {
        throw new Error("provider creds expired")
      },
      readLedger: () => entries,
      recordLiveness,
    })
    expect(recordLiveness).not.toHaveBeenCalled()
    expect(result.unknown).toBe(1)
    expect(result.gone).toBe(0)
    expect(result.rows[0]?.error).toContain("provider creds expired")
  })

  it("a probe() throw is 'unknown', never 'gone' — a transient network error must not orphan a live box", async () => {
    const entries = [entry({})]
    const recordLiveness = vi.fn()
    const result = await reconcileSandboxLedger({
      resolveProvider: async () => ({ provider: { probe: vi.fn(async () => { throw new Error("ETIMEDOUT") }) } }),
      readLedger: () => entries,
      recordLiveness,
    })
    expect(recordLiveness).not.toHaveBeenCalled()
    expect(result.unknown).toBe(1)
    expect(result.rows[0]?.error).toContain("ETIMEDOUT")
  })

  it("skips rows already 'stopped' or 'gone' — nothing left to reconcile", async () => {
    const entries = [entry({ sandboxId: "bx_stopped", state: "stopped" }), entry({ sandboxId: "bx_gone", state: "gone" })]
    const probe = vi.fn(async () => ({ alive: false }))
    const result = await reconcileSandboxLedger({
      resolveProvider: async () => ({ provider: { probe } }),
      readLedger: () => entries,
      recordLiveness: vi.fn(),
    })
    expect(probe).not.toHaveBeenCalled()
    expect(result.checked).toBe(0)
  })

  it("aggregates a mixed batch independently — one broken row never aborts the rest", async () => {
    const entries = [
      entry({ sandboxId: "bx_alive", state: "booted" }),
      entry({ sandboxId: "bx_gone", state: "paused" }),
      entry({ sandboxId: "bx_noprobe", state: "connected", provider: "local" }),
      entry({ sandboxId: "bx_broken", state: "paused" }),
    ]
    const result = await reconcileSandboxLedger({
      resolveProvider: async (slug: string) => {
        if (slug === "local") return { provider: {} }
        return {
          provider: {
            probe: async (id: string) => {
              if (id === "bx_broken") throw new Error("boom")
              return { alive: id === "bx_alive" }
            },
          },
        }
      },
      readLedger: () => entries,
      recordLiveness: vi.fn(),
    })
    expect(result.checked).toBe(4)
    expect(result.alive).toBe(1)
    expect(result.gone).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.unknown).toBe(1)
  })

  it("with default deps, reconciles against the real on-disk ledger via `ledgerPath` and flips state to 'gone'", async () => {
    const path = newLedgerPath()
    recordSandboxBoot({ sandboxId: "bx_real", provider: "e2b", state: "booted", path })
    const probe = vi.fn(async () => ({ alive: false }))
    const result = await reconcileSandboxLedger({
      resolveProvider: async () => ({ provider: { probe } }),
      ledgerPath: path,
    })
    expect(result).toEqual({
      checked: 1,
      alive: 0,
      gone: 1,
      unknown: 0,
      skipped: 0,
      rows: [{ sandboxId: "bx_real", provider: "e2b", verdict: "gone" }],
    })
    expect(readSandboxLedger(path).find(e => e.sandboxId === "bx_real")?.state).toBe("gone")
  })
})
