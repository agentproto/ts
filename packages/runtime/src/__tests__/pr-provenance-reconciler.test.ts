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
import type { ToolCallRecord } from "../tool-call-record.js"
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
    createPrProvenanceReconciler({ registry: reg,
      listToolCalls: async () => [], sessionEvents: bus, resolveOpenPr, run })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(recorded).toEqual([{ sessionId: "sess_exec", number: 42, url: PR.url }])
    expect(editBodies).toHaveLength(1)
    expect(editBodies[0]).toContain(MARKER)
    expect(editBodies[0]).toContain("supervisor `sess_super`")

    // A later event re-polls but de-dupes by url — no second stamp.
    bus.emit(exited("sess_exec"))
    await flush()
    expect(recorded).toHaveLength(1)
    expect(resolveOpenPr).toHaveBeenCalledTimes(2)
  })

  it("stamps each distinct PR a session opens (multi-PR)", async () => {
    const { reg, recorded } = fakeRegistry([execSession(), SUPER])
    const A = { number: 42, url: "https://github.com/o/r/pull/42" }
    const B = { number: 43, url: "https://github.com/o/r/pull/43" }
    let call = 0
    const resolveOpenPr: OpenPrResolver = async () => (call++ === 0 ? A : B)
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg,
      listToolCalls: async () => [], sessionEvents: bus, resolveOpenPr, run: okRun })

    bus.emit(turnEnd("sess_exec"))
    await flush()
    bus.emit(exited("sess_exec")) // terminal → bypasses the turn-end throttle
    await flush()

    expect(recorded.map(r => r.url)).toEqual([A.url, B.url])
  })

  it("does not re-stamp a PR already recorded on the descriptor", async () => {
    const { reg, recorded } = fakeRegistry([execSession({ openedPrs: [{ url: PR.url }] })])
    const edits: number[] = []
    const run: GhRunner = async args => {
      if (args[1] === "edit") edits.push(1)
      return { exitCode: 0, stdout: "Body." }
    }
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => PR)
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg,
      listToolCalls: async () => [], sessionEvents: bus, resolveOpenPr, run })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    // Resolved, then de-duped by url against openedPrs — no view/edit/record.
    expect(resolveOpenPr).toHaveBeenCalledTimes(1)
    expect(edits).toHaveLength(0)
    expect(recorded).toHaveLength(0)
  })

  it("does nothing when no open PR exists on turn-end", async () => {
    const { recorded, reg } = fakeRegistry([execSession()])
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => null)
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg,
      listToolCalls: async () => [], sessionEvents: bus, resolveOpenPr, run: okRun })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(resolveOpenPr).toHaveBeenCalledTimes(1)
    expect(recorded).toHaveLength(0)
  })

  it("throttles repeated turn-end polls for the same session", async () => {
    const { reg } = fakeRegistry([execSession()])
    const resolveOpenPr = vi.fn<OpenPrResolver>(async () => null)
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg,
      listToolCalls: async () => [], sessionEvents: bus, resolveOpenPr, run: okRun })

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
    createPrProvenanceReconciler({ registry: reg,
      listToolCalls: async () => [], sessionEvents: bus, resolveOpenPr, run: okRun })

    bus.emit(turnEnd("sess_exec", true)) // empty turn
    bus.emit(turnEnd("sess_cmd")) // not agent-cli
    await flush()

    expect(resolveOpenPr).not.toHaveBeenCalled()
  })

  it("neither re-edits nor records when the PR body already carries the marker", async () => {
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
      listToolCalls: async () => [],
      sessionEvents: bus,
      resolveOpenPr: async () => PR,
      run,
    })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(editCalls).toHaveLength(0)
    // An already-marked body belongs to whichever session stamped it first —
    // recording it on THIS session would misattribute it (the phantom-PR bug).
    expect(recorded).toHaveLength(0)
  })

  it("never throws out of a handler when gh fails", async () => {
    const { reg, recorded } = fakeRegistry([execSession()])
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({
      registry: reg,
      listToolCalls: async () => [],
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
    const reconciler = createPrProvenanceReconciler({ registry: reg,
      listToolCalls: async () => [], sessionEvents: bus, resolveOpenPr, run: okRun })

    reconciler.dispose()
    bus.emit(turnEnd("sess_exec"))
    bus.emit(exited("sess_exec"))
    await flush()

    expect(resolveOpenPr).not.toHaveBeenCalled()
  })
})

// ─── Lane A: exact attribution from recorded tool calls ─────────────────────
describe("createPrProvenanceReconciler — recorded-tool-call lane", () => {
  const createRecord = (sessionId: string, number: number): ToolCallRecord => ({
    sessionId,
    tool: "bash",
    command: `gh pr create --title t-${number}`,
    isError: false,
    createdPrUrl: `https://github.com/o/r/pull/${number}`,
    createdPrNumber: number,
    ts: "t",
  })

  it("stamps from the session's own record even when the branch no longer resolves (chat back on main)", async () => {
    // The blind spot this lane closes: the session branched, opened the PR,
    // and checked the shared main checkout back out within one turn — so by
    // turn-end the branch resolver answers null. The record still names it.
    const { reg, recorded } = fakeRegistry([execSession(), SUPER])
    const editBodies: string[] = []
    const run: GhRunner = async args => {
      if (args[1] === "view") return { exitCode: 0, stdout: "Body." }
      editBodies.push(String(args[4]))
      return { exitCode: 0, stdout: "" }
    }
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({
      registry: reg,
      sessionEvents: bus,
      resolveOpenPr: async () => null,
      listToolCalls: async id => (id === "sess_exec" ? [createRecord("sess_exec", 77)] : []),
      run,
    })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(recorded).toEqual([
      { sessionId: "sess_exec", number: 77, url: "https://github.com/o/r/pull/77" },
    ])
    expect(editBodies).toHaveLength(1)
    expect(editBodies[0]).toContain(MARKER)
    expect(editBodies[0]).toContain("`sess_exec`")
  })

  it("attributes each PR to ITS author when two different sessions share one cwd", async () => {
    // Two chat sessions in the same repo-root checkout, each opened its own
    // PR mid-turn. Branch resolution answers null for both (default-branch
    // guard) — the records keep the attributions apart.
    const a = execSession({ id: "sess_a", parentSessionId: undefined })
    const b = execSession({ id: "sess_b", parentSessionId: undefined })
    const { reg, recorded } = fakeRegistry([a, b])
    const editBodies: string[] = []
    const run: GhRunner = async args => {
      if (args[1] === "view") return { exitCode: 0, stdout: "Body." }
      editBodies.push(String(args[4]))
      return { exitCode: 0, stdout: "" }
    }
    const records: Record<string, ToolCallRecord[]> = {
      sess_a: [createRecord("sess_a", 101)],
      sess_b: [createRecord("sess_b", 102)],
    }
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({
      registry: reg,
      sessionEvents: bus,
      resolveOpenPr: async () => null,
      listToolCalls: async id => records[id] ?? [],
      run,
    })

    bus.emit(turnEnd("sess_b"))
    await flush()
    bus.emit(turnEnd("sess_a"))
    await flush()

    expect(recorded).toEqual([
      { sessionId: "sess_b", number: 102, url: "https://github.com/o/r/pull/102" },
      { sessionId: "sess_a", number: 101, url: "https://github.com/o/r/pull/101" },
    ])
    expect(editBodies).toHaveLength(2)
    expect(editBodies[0]).toContain("`sess_b`")
    expect(editBodies[1]).toContain("`sess_a`")
  })

  it("does not let a same-cwd sibling steal a PR another session already stamped via lane B", async () => {
    // sess_a stamps its PR from its record; later sess_b's turn ends while
    // the shared cwd's branch still resolves to sess_a's PR — the shared
    // per-PR dedupe must stop lane B from restamping it as sess_b's.
    const a = execSession({ id: "sess_a", parentSessionId: undefined })
    const b = execSession({ id: "sess_b", parentSessionId: undefined })
    const { reg, recorded } = fakeRegistry([a, b])
    const editBodies: string[] = []
    const run: GhRunner = async args => {
      if (args[1] === "view") return { exitCode: 0, stdout: "Body." }
      editBodies.push(String(args[4]))
      return { exitCode: 0, stdout: "" }
    }
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({
      registry: reg,
      sessionEvents: bus,
      resolveOpenPr: async () => ({ number: 101, url: "https://github.com/o/r/pull/101" }),
      listToolCalls: async id => (id === "sess_a" ? [createRecord("sess_a", 101)] : []),
      run,
    })

    bus.emit(turnEnd("sess_a"))
    await flush()
    bus.emit(turnEnd("sess_b"))
    await flush()

    expect(recorded).toEqual([
      { sessionId: "sess_a", number: 101, url: "https://github.com/o/r/pull/101" },
    ])
    expect(editBodies).toHaveLength(1)
    expect(editBodies[0]).toContain("`sess_a`")
  })

  it("skips a recorded PR already on the descriptor without touching gh", async () => {
    const { reg, recorded } = fakeRegistry([
      execSession({ openedPrs: [{ url: "https://github.com/o/r/pull/77" }] }),
    ])
    const run = vi.fn<GhRunner>(async () => ({ exitCode: 0, stdout: "" }))
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({
      registry: reg,
      sessionEvents: bus,
      resolveOpenPr: async () => null,
      listToolCalls: async () => [createRecord("sess_exec", 77)],
      run,
    })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(run).not.toHaveBeenCalled()
    expect(recorded).toHaveLength(0)
  })

  it("still falls back to branch resolution for a session with no usable records", async () => {
    const { reg, recorded } = fakeRegistry([execSession(), SUPER])
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({
      registry: reg,
      sessionEvents: bus,
      resolveOpenPr: async () => PR,
      listToolCalls: async () => [
        { sessionId: "sess_exec", tool: "bash", command: "ls", isError: false, ts: "t" },
      ],
      run: okRun,
    })

    bus.emit(turnEnd("sess_exec"))
    await flush()

    expect(recorded).toEqual([{ sessionId: "sess_exec", number: 42, url: PR.url }])
  })

  it("refreshes a recorded PR's footer with the session's spend once it is known — once", async () => {
    // Stamped mid-turn (no cost), then the session learns its spend.
    const session = execSession({ openedPrs: [{ url: PR.url, number: PR.number }] })
    const { reg } = fakeRegistry([session, SUPER])
    let body = "Body.\n\n---\n<sub>🤖 **" + MARKER + "** — PR · session `sess_exec` · claude-code · host `h` · cwd `/wt`</sub>"
    const edits: string[] = []
    const run: GhRunner = async args => {
      if (args[1] === "view") return { exitCode: 0, stdout: body }
      if (args[1] === "edit") {
        body = args[4] as string
        edits.push(body)
      }
      return { exitCode: 0, stdout: "" }
    }
    const bus = createSessionEventBus()
    createPrProvenanceReconciler({ registry: reg,
      listToolCalls: async () => [], sessionEvents: bus, resolveOpenPr: async () => null, run })

    // No cost yet → nothing to refresh.
    bus.emit(turnEnd("sess_exec"))
    await flush()
    expect(edits).toEqual([])

    // Cost learned at turn-end → footer re-rendered exactly once.
    session.costUsd = 0.42
    bus.emit(exited("sess_exec"))
    await flush()
    expect(edits.length).toBe(1)
    const refreshed = edits[0] ?? ""
    expect(refreshed).toContain("$0.4200")
    expect(refreshed.match(new RegExp("<sub>[^\\n]*" + MARKER, "g"))?.length).toBe(1)
    expect(refreshed.startsWith("Body.")).toBe(true)

    // A later turn-end with the same (or higher) cost does not edit again.
    session.costUsd = 0.99
    bus.emit(exited("sess_exec"))
    await flush()
    expect(edits.length).toBe(1)
  })
})
