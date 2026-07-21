/**
 * Unit tests for the daemon PR-provenance RECONCILER
 * (pr-provenance-reconciler.ts). Uses a REAL event bus (so `on`/`emit` are
 * exercised as wired) with fake registry / resolver / gh runner. The handlers
 * schedule the reconcile fire-and-forget, so each test awaits a macrotask tick
 * (`flush`) after emitting to let the async reconcile settle.
 */

import { describe, expect, it, vi } from "vitest"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import {
  createPrProvenanceReconciler,
  type OpenPrResolver,
  type ReconcilerRegistry,
  type ReconcilerSession,
} from "../pr-provenance-reconciler.js"
import type { GhRunner } from "../pr-provenance-stamp.js"
import { MARKER } from "../pr-provenance.js"

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const PR = { number: 42, url: "https://github.com/o/r/pull/42" }

function execSession(over: Partial<ReconcilerSession> = {}): ReconcilerSession {
  return {
    id: "sess_exec",
    kind: "agent-cli",
    cwd: "/wt",
    harness: "claude-code",
    adapterSlug: "claude-code",
    parentSessionId: "sess_super",
    ...over,
  }
}

const SUPER: ReconcilerSession = { id: "sess_super", kind: "agent-cli", cwd: "/" }

function fakeRegistry(sessions: ReconcilerSession[]): {
  reg: ReconcilerRegistry
  recorded: Array<{ sessionId: string; number: number; url: string }>
} {
  const recorded: Array<{ sessionId: string; number: number; url: string }> = []
  const reg: ReconcilerRegistry = {
    get: id => sessions.find(s => s.id === id),
    list: () => sessions,
    recordOpenedPr: (sessionId, input) => {
      recorded.push({ sessionId, number: input.number, url: input.url })
      // Mirror the real registry: the session now carries the PR, which the
      // reconciler's dedupe path reads on the next event.
      const s = sessions.find(x => x.id === sessionId)
      if (s) s.openedPrs = [...(s.openedPrs ?? []), { url: input.url }]
      return undefined
    },
  }
  return { reg, recorded }
}

const okRun: GhRunner = async args =>
  args[1] === "view" ? { exitCode: 0, stdout: "Body." } : { exitCode: 0, stdout: "" }

const turnEnd = (sessionId: string, empty = false): SessionEvent => ({
  type: "session:turn-end",
  sessionId,
  awaitingInput: false,
  ts: "t",
  ...(empty ? { empty: true } : {}),
})

const exited = (sessionId: string): SessionEvent => ({
  type: "session:exited",
  sessionId,
  status: "exited",
  ts: "t",
})

describe("createPrProvenanceReconciler", () => {
  it("stamps once on turn-end when an open PR exists, then dedupes", async () => {
    const { reg, recorded } = fakeRegistry([execSession(), SUPER])
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => PR)
    const editBodies: string[] = []
    const run: GhRunner = async args => {
      if (args[1] === "view") return { exitCode: 0, stdout: "Body." }
      if (args[1] === "edit") editBodies.push(args[4] as string)
      return { exitCode: 0, stdout: "" }
    }
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg, sessionEvents: bus, resolveOpenPr, run })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(recorded).toEqual([{ sessionId: "sess_exec", number: 42, url: PR.url }])
    expect(editBodies).toHaveLength(1)
    expect(editBodies[0]).toContain(MARKER)
    expect(editBodies[0]).toContain("supervisor `sess_super`")

    // A later event does not re-poll or re-stamp.
    bus.emit(exited("sess_exec"))
    await flush()
    expect(recorded).toHaveLength(1)
    expect(resolveOpenPr).toHaveBeenCalledTimes(1)
  })

  it("skips a session that already recorded a PR (openedPrs) without polling", async () => {
    const { reg, recorded } = fakeRegistry([execSession({ openedPrs: [{ url: PR.url }] })])
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => PR)
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg, sessionEvents: bus, resolveOpenPr, run: okRun })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(resolveOpenPr).not.toHaveBeenCalled()
    expect(recorded).toHaveLength(0)
  })

  it("does nothing when no open PR exists on turn-end", async () => {
    const { recorded, reg } = fakeRegistry([execSession()])
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => null)
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg, sessionEvents: bus, resolveOpenPr, run: okRun })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(resolveOpenPr).toHaveBeenCalledTimes(1)
    expect(recorded).toHaveLength(0)
  })

  it("stops polling after a terminal exit with no PR", async () => {
    const { reg } = fakeRegistry([execSession()])
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => null)
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg, sessionEvents: bus, resolveOpenPr, run: okRun })

    bus.emit(exited("sess_exec"))
    await flush()
    bus.emit(turnEnd("sess_exec"))
    await flush()

    // The exit marked the session handled → the later turn-end never re-polls.
    expect(resolveOpenPr).toHaveBeenCalledTimes(1)
  })

  it("throttles repeated turn-end polls for the same session", async () => {
    const { reg } = fakeRegistry([execSession()])
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => null)
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg, sessionEvents: bus, resolveOpenPr, run: okRun })

    bus.emit(turnEnd("sess_exec"))
    await flush()
    bus.emit(turnEnd("sess_exec"))
    await flush()

    // Second turn-end lands within the throttle window → one poll only.
    expect(resolveOpenPr).toHaveBeenCalledTimes(1)
  })

  it("skips silent no-op turns and non-agent-cli sessions", async () => {
    const { reg } = fakeRegistry([execSession(), execSession({ id: "sess_cmd", kind: "command" })])
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => PR)
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg, sessionEvents: bus, resolveOpenPr, run: okRun })

    bus.emit(turnEnd("sess_exec", true)) // empty turn
    bus.emit(turnEnd("sess_cmd")) // not agent-cli
    await flush()

    expect(resolveOpenPr).not.toHaveBeenCalled()
  })

  it("records but does not re-edit when the PR body already carries the marker", async () => {
    const { reg, recorded } = fakeRegistry([execSession(), SUPER])
    const editCalls: number[] = []
    const run: GhRunner = async args => {
      if (args[1] === "view") return { exitCode: 0, stdout: `Body.\n\n---\n<sub>${MARKER} — PR</sub>` }
      editCalls.push(1)
      return { exitCode: 0, stdout: "" }
    }
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({
      registry: reg,
      sessionEvents: bus,
      resolveOpenPr: async () => PR,
      run,
    })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(editCalls).toHaveLength(0)
    expect(recorded).toHaveLength(1)
  })

  it("never throws out of a handler when gh fails", async () => {
    const { reg, recorded } = fakeRegistry([execSession()])
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({
      registry: reg,
      sessionEvents: bus,
      resolveOpenPr: async () => PR,
      run: async () => {
        throw new Error("gh not found")
      },
    })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    // Swallowed → not marked handled, not recorded, no unhandled rejection.
    expect(recorded).toHaveLength(0)
  })

  it("dispose() detaches the subscriptions", async () => {
    const { reg } = fakeRegistry([execSession()])
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => null)
    const bus = createSessionEventBus()
    const reconciler = createPrProvenanceReconciler({ registry: reg, sessionEvents: bus, resolveOpenPr, run: okRun })

    reconciler.dispose()
    bus.emit(turnEnd("sess_exec"))
    bus.emit(exited("sess_exec"))
    await flush()

    expect(resolveOpenPr).not.toHaveBeenCalled()
  })
})
