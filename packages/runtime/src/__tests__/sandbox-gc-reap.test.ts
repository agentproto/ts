/**
 * Sandbox gc — capacity-free reaping + the automatic dead-session pass.
 *
 * 1. `reapGcEntry` MUST prefer the provider's `remove()` (a control-plane
 *    destroy WITHOUT connecting) over `connect()` + `stop()`: connecting to
 *    a suspended computer first RESUMES it, needing the very RAM the gc is
 *    meant to free — the observed "capacity exhausted (available 511)" on
 *    `sandbox rm`/gc, 2026-10-20. An already-gone id is a no-op success.
 *    Explicit `pause` keeps the connect path (a pause needs the handle).
 * 2. `runSandboxGcPass` reaps exactly the ledger boxes whose origin session
 *    is dead, tallies the pass, and never throws.
 * 3. `startSandboxGcTimer` runs the pass on its interval and stops cleanly.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"
import {
  DEFAULT_SANDBOX_GC_INTERVAL_MS,
  reapGcEntry,
  parseSandboxGcInterval,
  runSandboxGcPass,
  startSandboxGcTimer,
  type SandboxGcProviderHandle,
} from "../sandbox-gc.js"
import type { SandboxLedgerEntry } from "../sandbox-ledger.js"

const entryOf = (overrides: Partial<SandboxLedgerEntry> = {}): SandboxLedgerEntry => ({
  sandboxId: "bx_1",
  provider: "fake",
  state: "paused",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
  originSessionId: "sess_origin",
  ...overrides,
})

const cleanupDirs: string[] = []
/** Seed the ledger file with `rows` (upsert-style shape). */
async function seedLedger(path: string, rows: SandboxLedgerEntry[]): Promise<void> {
  await writeFile(path, JSON.stringify({ sandboxes: rows, schemaVersion: 1 }))
}
async function tmpLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-gc-reap-"))
  cleanupDirs.push(dir)
  return join(await realpathSync(dir) + "", "sandbox-ledger.json")
}
afterEach(async () => {
  while (cleanupDirs.length) await rm(cleanupDirs.pop()!, { recursive: true, force: true })
})

function fakeHandle(opts: {
  remove?: (id: string) => Promise<void>
  connect?: (id: string) => Promise<{ sandboxId: string; stop(): Promise<void> }>
}): { provider: SandboxGcProviderHandle["provider"] } {
  const provider: NonNullable<SandboxGcProviderHandle["provider"]> = {}
  if (!opts.remove && !opts.connect) {
    throw new Error("makeFakeHandle needs a remove or a connect")
  }
  provider.remove = opts.remove
  provider.connect = opts.connect
    ? (id: string) => opts.connect!(id)
    : undefined
  return { provider }
}
// prune undefined keys so the structural type stays optional-clean
function cleaned<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
function handleFor(opts: Parameters<typeof fakeHandle>[0]): { provider: SandboxGcProviderHandle["provider"] } {
  return cleaned(fakeHandle(opts)) as { provider: SandboxGcProviderHandle["provider"] }
}

describe("reapGcEntry — capacity-free reaping", () => {
  it("prefers remove() and NEVER connects (a suspended box must not be resumed to gc it)", async () => {
    const remove = vi.fn(async (_id: string) => {})
    const connect = vi.fn(async (_id: string) => ({ sandboxId: "bx_1", stop: vi.fn(async () => {}) }))
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [entryOf()])
    const res = await reapGcEntry(entryOf(), {
      resolveProvider: async () => handleFor({ remove, connect }),
      ledgerPath: ledger,
    })
    expect(res).toEqual({ ok: true, action: "stopped" })
    expect(remove).toHaveBeenCalledWith("bx_1", { force: true })
    expect(connect).not.toHaveBeenCalled()
    // The ledger row is stamped stopped so the candidate never reappears.
    expect(readFileSync(ledger, "utf8")).toContain('"stopped"')
    expect(readFileSync(ledger, "utf8")).toContain('"bx_1"')
  })

  it("an already-gone id is a no-op success (gc converges)", async () => {
    const ledger = await tmpLedgerPath()
    // The typed sentinel (Error.name === "SandboxBoxGoneError")…
    const goneErr = new Error("box not found: bx_1")
    goneErr.name = "SandboxBoxGoneError"
    const res = await reapGcEntry(entryOf(), {
      resolveProvider: async () => handleFor({ remove: async () => { throw goneErr } }),
      ledgerPath: ledger,
    })
    expect(res).toEqual({ ok: true, action: "stopped" })
    // …and the message-based shapes (404 / "doesn't exist").
    const res2 = await reapGcEntry(entryOf({ sandboxId: "bx_2" }), {
      resolveProvider: async () =>
        handleFor({
          remove: async () => {
            throw new Error("sandbox doesn't exist (404)")
          },
        }),
      ledgerPath: ledger,
    })
    expect(res2).toEqual({ ok: true, action: "stopped" })
  })

  it("a reconnect whose provider says the box 'no longer exists' stamps the row stopped, not a repeat failure", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [entryOf({ sandboxId: "bx_vanished", state: "paused" })])
    const goneErr = new Error(
      'sandbox "bx_vanished" no longer exists on its provider — the box is gone',
    )
    goneErr.name = "SandboxBoxGoneError"
    const res = await reapGcEntry(entryOf({ sandboxId: "bx_vanished" }), {
      // Explicit pause reaches the connect path (remove is skipped).
      pause: true,
      resolveProvider: async () =>
        handleFor({ connect: async () => { throw goneErr } }),
      ledgerPath: ledger,
    })
    expect(res).toEqual({ ok: true, action: "stopped" })
    expect(readFileSync(ledger, "utf8")).toContain('"stopped"')
  })

  it("a REAL remove failure leaves the ledger row alone", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [entryOf()])
    const res = await reapGcEntry(entryOf(), {
      resolveProvider: async () =>
        handleFor({
          remove: async () => {
            throw new Error("controller unreachable")
          },
        }),
      ledgerPath: ledger,
    })
    expect(res.ok).toBe(false)
    // The seeded row is untouched — still paused, NOT stamped stopped.
    expect(readFileSync(ledger, "utf8")).toContain('"state":"paused"')
  })

  it("an UNRELATED 'not found' error (provider lookup wording) is a failure, not a gone-box success", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [entryOf()])
    const res = await reapGcEntry(entryOf(), {
      resolveProvider: async () =>
        handleFor({
          remove: async () => {
            throw new Error(`provider "sandbox-computer" not found: ${entryOf().sandboxId}`)
          },
        }),
      ledgerPath: ledger,
    })
    expect(res.ok).toBe(false)
    expect(readFileSync(ledger, "utf8")).toContain('"state":"paused"')
  })

  it("an explicit pause bypasses remove and uses the connect path", async () => {
    const remove = vi.fn(async (_id: string) => {})
    const stop = vi.fn(async () => {})
    const connect = vi.fn(async () => ({ sandboxId: "bx_1", stop }))
    const res = await reapGcEntry(entryOf(), {
      pause: true,
      resolveProvider: async () => handleFor({ remove, connect }),
    })
    expect(res).toEqual({ ok: true, action: "stopped" })
    expect(remove).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })

  it("a provider without remove() falls back to connect + stop as before", async () => {
    const stop = vi.fn(async () => {})
    const connect = vi.fn(async () => ({ sandboxId: "bx_1", stop }))
    const res = await reapGcEntry(entryOf(), {
      resolveProvider: async () => handleFor({ connect }),
    })
    expect(res).toEqual({ ok: true, action: "stopped" })
    expect(stop).toHaveBeenCalled()
  })
})

describe("runSandboxGcPass — the automatic dead-session pass", () => {
  it("reaps exactly the dead-session boxes and tallies the pass", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [
      entryOf({ sandboxId: "bx_dead", state: "connected", originSessionId: "sess_dead" }),
      entryOf({ sandboxId: "bx_fail", state: "connected", originSessionId: "sess_dead" }),
      entryOf({ sandboxId: "bx_live", state: "connected", originSessionId: "sess_live" }),
    ])
    const remove = vi.fn(async (_id: string) => {})
    const failRemove = vi.fn(async (_id: string) => {
      throw new Error("controller unreachable")
    })
    const summary = await runSandboxGcPass(
      {
        fetchSessionStatuses: () =>
          new Map([
            ["sess_dead", "exited"],
            ["sess_live", "running"],
          ]),
        resolveProvider: async slug =>
          slug === "fake" ? handleFor({ remove: async id => (id === "bx_fail" ? failRemove(id) : remove(id)) }) : null,
        ledgerPath: ledger,
      },
      line => lines.push(line),
    )
    expect(summary).toEqual({
      ran: true,
      candidates: 2,
      stopped: 1,
      paused: 0,
      kept: 0,
      failures: 1,
    })
    expect(remove).toHaveBeenCalledWith("bx_dead")
    expect(failRemove).toHaveBeenCalledWith("bx_fail")
    // The dead boxes' rows are stamped stopped; the live one untouched here.
    expect(readFileSync(ledger, "utf8")).toContain('"stopped"')
  })

  it("a row whose origin recorded a PAUSE teardown is paused, never deleted", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [
      entryOf({ sandboxId: "bx_pause_teardown", state: "connected", originSessionId: "sess_dead" }),
    ])
    const pause = vi.fn(async () => {})
    const remove = vi.fn(async (_id: string, _opts?: { force?: boolean }) => {})
    const stop = vi.fn(async () => {})
    const summary = await runSandboxGcPass(
      {
        fetchSessionStatuses: () => new Map([["sess_dead", "error"]]),
        fetchSessionLineage: () => new Map([["sess_dead", { sandboxTeardown: "pause", resumable: false }]]),
        resolveProvider: async () =>
          ({
            provider: {
              remove,
              connect: async (id: string) => ({ sandboxId: id, stop, pause }),
            },
          }) as SandboxGcProviderHandle,
        ledgerPath: ledger,
      },
      line => lines.push(line),
    )
    expect(summary).toEqual({ ran: true, candidates: 1, stopped: 0, paused: 1, kept: 0, failures: 0 })
    expect(pause).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    // Stamped paused (not stopped), so a later pass sees it as kept.
    expect(readFileSync(ledger, "utf8")).toContain('"paused"')
  })

  it("a dead origin with a kill (or unset) teardown is still deleted, as on main", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [
      entryOf({ sandboxId: "bx_kill_teardown", state: "connected", originSessionId: "sess_dead" }),
    ])
    const pause = vi.fn(async () => {})
    const remove = vi.fn(async (_id: string, _opts?: { force?: boolean }) => {})
    const summary = await runSandboxGcPass({
      fetchSessionStatuses: () => new Map([["sess_dead", "killed"]]),
      fetchSessionLineage: () => new Map([["sess_dead", { sandboxTeardown: "kill" }]]),
      resolveProvider: async () =>
        ({
          provider: {
            remove,
            connect: async (id: string) => ({ sandboxId: id, stop: vi.fn(async () => {}), pause }),
          },
        }) as SandboxGcProviderHandle,
      ledgerPath: ledger,
    })
    expect(summary).toEqual({ ran: true, candidates: 1, stopped: 1, paused: 0, kept: 0, failures: 0 })
    expect(remove).toHaveBeenCalledWith("bx_kill_teardown", { force: true })
    expect(pause).not.toHaveBeenCalled()
  })

  it("shouldPause honours a SUCCESSOR's sandboxTeardown, not only the origin's", async () => {
    const { sandboxGcShouldPause } = await import("../sandbox-gc.js")
    const entry = entryOf({ state: "connected", originSessionId: "sess_origin" })
    const lineage = new Map([
      ["sess_origin", { sandboxTeardown: "kill" as const }],
      ["sess_successor", { resumedFrom: "sess_origin", sandboxTeardown: "pause" as const }],
    ])
    expect(sandboxGcShouldPause(entry, lineage)).toBe(true)
  })

  it("shouldPause honours an ATTACHED session's sandboxTeardown", async () => {
    const { sandboxGcShouldPause } = await import("../sandbox-gc.js")
    const entry = entryOf({
      state: "connected",
      originSessionId: "sess_origin",
      attachedSessions: ["sess_origin", "sess_attache"],
    })
    const lineage = new Map([
      ["sess_origin", { sandboxTeardown: "kill" as const }],
      ["sess_attache", { sandboxTeardown: "pause" as const }],
    ])
    expect(sandboxGcShouldPause(entry, lineage)).toBe(true)
  })

  it("a row already paused on the ledger is kept with NO provider call", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [
      entryOf({ sandboxId: "bx_already_paused", state: "paused", originSessionId: "sess_dead" }),
    ])
    const pause = vi.fn(async () => {})
    const remove = vi.fn(async (_id: string, _opts?: { force?: boolean }) => {})
    const connect = vi.fn(async (id: string) => ({ sandboxId: id, stop: vi.fn(async () => {}), pause }))
    const summary = await runSandboxGcPass(
      {
        fetchSessionStatuses: () => new Map([["sess_dead", "error"]]),
        fetchSessionLineage: () => new Map([["sess_dead", { sandboxTeardown: "pause" }]]),
        resolveProvider: async () => ({ provider: { remove, connect } }) as SandboxGcProviderHandle,
        ledgerPath: ledger,
        // Keep the age bound out of this test: the row is old on purpose.
        pausedMaxAgeMs: Number.POSITIVE_INFINITY,
      },
      line => lines.push(line),
    )
    expect(summary).toEqual({ ran: true, candidates: 1, stopped: 0, paused: 0, kept: 1, failures: 0 })
    expect(connect).not.toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(readFileSync(ledger, "utf8")).toContain('"paused"')
  })

  it("a paused row PAST the age bound is reaped (kill, not kept) even with a pause teardown", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [
      entryOf({ sandboxId: "bx_paused_expired", state: "paused", originSessionId: "sess_dead" }),
    ])
    const pause = vi.fn(async () => {})
    const remove = vi.fn(async (_id: string, _opts?: { force?: boolean }) => {})
    const connect = vi.fn(async (id: string) => ({ sandboxId: id, stop: vi.fn(async () => {}), pause }))
    const summary = await runSandboxGcPass(
      {
        fetchSessionStatuses: () => new Map([["sess_dead", "killed"]]),
        fetchSessionLineage: () => new Map([["sess_dead", { sandboxTeardown: "pause" }]]),
        resolveProvider: async () => ({ provider: { remove, connect } }) as SandboxGcProviderHandle,
        ledgerPath: ledger,
        pausedMaxAgeMs: 30 * 60_000,
      },
      line => lines.push(line),
    )
    expect(summary).toEqual({ ran: true, candidates: 1, stopped: 1, paused: 0, kept: 0, failures: 0 })
    expect(remove).toHaveBeenCalledWith("bx_paused_expired", { force: true })
    expect(connect).not.toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()
    expect(readFileSync(ledger, "utf8")).toContain('"stopped"')
    expect(lines.some(line => line.includes("paused for") && line.includes("reaping"))).toBe(true)
  })

  it("a paused row whose origin teardown is kill/unset is still deleted", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [
      entryOf({ sandboxId: "bx_paused_stale", state: "paused", originSessionId: "sess_dead" }),
    ])
    const remove = vi.fn(async (_id: string, _opts?: { force?: boolean }) => {})
    const pause = vi.fn(async () => {})
    const summary = await runSandboxGcPass(
      {
        fetchSessionStatuses: () => new Map([["sess_dead", "error"]]),
        // No lineage entry: teardown is unset, so the paused box must not leak.
        resolveProvider: async () =>
          ({
            provider: {
              remove,
              connect: async (id: string) => ({ sandboxId: id, stop: vi.fn(async () => {}), pause }),
            },
          }) as SandboxGcProviderHandle,
        ledgerPath: ledger,
      },
      line => lines.push(line),
    )
    expect(summary).toEqual({ ran: true, candidates: 1, stopped: 1, paused: 0, kept: 0, failures: 0 })
    expect(remove).toHaveBeenCalledWith("bx_paused_stale", { force: true })
    expect(pause).not.toHaveBeenCalled()
    expect(readFileSync(ledger, "utf8")).toContain('"stopped"')
  })

  it("a paused row whose origin teardown is EXPLICIT kill is still deleted", async () => {
    const ledger = await tmpLedgerPath()
    await seedLedger(ledger, [
      entryOf({ sandboxId: "bx_paused_kill", state: "paused", originSessionId: "sess_dead" }),
    ])
    const remove = vi.fn(async (_id: string, _opts?: { force?: boolean }) => {})
    const pause = vi.fn(async () => {})
    const summary = await runSandboxGcPass(
      {
        fetchSessionStatuses: () => new Map([["sess_dead", "error"]]),
        fetchSessionLineage: () => new Map([["sess_dead", { sandboxTeardown: "kill" }]]),
        resolveProvider: async () =>
          ({
            provider: {
              remove,
              connect: async (id: string) => ({ sandboxId: id, stop: vi.fn(async () => {}), pause }),
            },
          }) as SandboxGcProviderHandle,
        ledgerPath: ledger,
      },
      line => lines.push(line),
    )
    expect(summary).toEqual({ ran: true, candidates: 1, stopped: 1, paused: 0, kept: 0, failures: 0 })
    expect(remove).toHaveBeenCalledWith("bx_paused_kill", { force: true })
    expect(pause).not.toHaveBeenCalled()
    expect(readFileSync(ledger, "utf8")).toContain('"stopped"')
  })

  it("skips live sessions entirely (nothing to reap, nothing to call)", async () => {
    const remove = vi.fn(async (_id: string) => {})
    const summary = await runSandboxGcPass({
      fetchSessionStatuses: () => new Map([["sess_live", "running"]]),
      resolveProvider: async () => handleFor({ remove }),
    })
    expect(summary).toEqual({ ran: true, candidates: 0, stopped: 0, paused: 0, kept: 0, failures: 0 })
    expect(remove).not.toHaveBeenCalled()
  })
})

const lines: string[] = []
afterEach(() => {
  while (lines.length) lines.pop()
})

describe("parseSandboxGcInterval — the env knob", () => {
  const FALLBACK = 123_456
  it("unset or non-numeric falls back to the default", () => {
    expect(parseSandboxGcInterval(undefined, FALLBACK)).toBe(FALLBACK)
    expect(parseSandboxGcInterval("", FALLBACK)).toBe(FALLBACK)
    expect(parseSandboxGcInterval("soon", FALLBACK)).toBe(FALLBACK)
  })
  it("a positive value overrides the default", () => {
    expect(parseSandboxGcInterval("5000", FALLBACK)).toBe(5000)
  })
  it("an explicit 0 (or negative) DISABLES the timer — 0 is returned, not the default", () => {
    expect(parseSandboxGcInterval("0", FALLBACK)).toBe(0)
    expect(parseSandboxGcInterval("-1", FALLBACK)).toBe(0)
  })
  it("the documented default is the 1 h cadence", () => {
    expect(DEFAULT_SANDBOX_GC_INTERVAL_MS).toBe(60 * 60_000)
    expect(parseSandboxGcInterval(undefined)).toBe(60 * 60_000)
  })
})

describe("startSandboxGcTimer — wiring shape", () => {
  it("runs the pass on its interval and stops cleanly", async () => {
    vi.useFakeTimers()
    let passes = 0
    const timer = startSandboxGcTimer({
      fetchSessionStatuses: () => {
        passes++
        return new Map()
      },
      resolveProvider: async () => null,
      intervalMs: 60_000,
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(passes).toBe(1)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(passes).toBe(3)
    timer.stop()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(passes).toBe(3)
    vi.useRealTimers()
  })

  it("a throwing pass is logged and swallowed — the timer keeps going", async () => {
    vi.useFakeTimers()
    const warns: string[] = []
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      warns.push(String(line))
    })
    const timer = startSandboxGcTimer({
      fetchSessionStatuses: () => {
        throw new Error("daemon unreachable")
      },
      resolveProvider: async () => null,
      intervalMs: 60_000,
    })
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(warns.some(line => line.includes("pass failed — daemon unreachable"))).toBe(true)
    timer.stop()
    vi.useRealTimers()
  })
})
