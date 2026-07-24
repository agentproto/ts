import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  isResumable,
  type AgentSessionLike,
  type SessionDescriptor,
} from "../sessions.js"
import {
  runCrashDetectPass,
  type CrashReaperRegistry,
} from "../crash-reaper.js"
import { createSessionEventBus } from "../session-event-bus.js"

/**
 * Crash-detect sweep (crash-detect PR-1).
 *
 * Two layers, tested separately, mirroring idle-reaper.test.ts:
 *   1. `runCrashDetectPass` — the POLICY (which running rows are provably
 *      dead). Driven against a stub registry so candidate selection is
 *      deterministic and never touches a real OS process.
 *   2. `registry.markCrashed` — the ACTION (flip to error/crashed, append the
 *      banner, clear the binding, emit session:exited). Driven against a real
 *      registry with a live spawned agent session whose pid is faked dead via
 *      a `process.kill` mock (the same technique sessions.test.ts's
 *      "liveness: pid / lastActivityAt / processAlive" suite uses).
 */

// ── Layer 1: candidate-selection policy (stub registry) ───────────────────

/** A base LOCAL agent-cli row, running with a dead pid — the default
 *  candidate shape. Override per case. */
function row(over: Partial<SessionDescriptor> & { id: string }): SessionDescriptor {
  return {
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude (agent)",
    pid: 4242,
    processAlive: false,
    status: "running",
    startedAt: "2026-07-23T00:00:00Z",
    adapterSlug: "claude-code",
    adapterSessionId: `acp-${over.id}`,
    cwd: "/tmp",
    ...over,
  }
}

/** A stub registry that records every `markCrashed` call and always
 *  succeeds — so a test asserts EXACTLY which rows the policy selected. */
function stubRegistry(rows: SessionDescriptor[]): {
  registry: CrashReaperRegistry
  crashed: string[]
} {
  const crashed: string[] = []
  const registry: CrashReaperRegistry = {
    list: () => rows,
    markCrashed: id => {
      crashed.push(id)
      return true
    },
  }
  return { registry, crashed }
}

const THIRTY_SEC = 30_000

describe("runCrashDetectPass — candidate selection", () => {
  it("marks a running agent-cli session whose pid is confirmed dead", () => {
    const { registry, crashed } = stubRegistry([row({ id: "dead" })])
    const summary = runCrashDetectPass({ registry, crashDetectIntervalMs: THIRTY_SEC })
    expect(summary).toEqual({ enabled: true, candidates: 1, crashed: 1, ids: ["dead"] })
    expect(crashed).toEqual(["dead"])
  })

  it("does NOT mark a session whose pid is confirmed alive", () => {
    const { registry, crashed } = stubRegistry([row({ id: "alive", processAlive: true })])
    expect(runCrashDetectPass({ registry, crashDetectIntervalMs: THIRTY_SEC }).crashed).toBe(0)
    expect(crashed).toEqual([])
  })

  it("does NOT mark a session with no liveness probe result (processAlive undefined)", () => {
    const { registry, crashed } = stubRegistry([row({ id: "unprobed", processAlive: undefined })])
    expect(runCrashDetectPass({ registry, crashDetectIntervalMs: THIRTY_SEC }).crashed).toBe(0)
    expect(crashed).toEqual([])
  })

  it("does NOT mark a session with no pid (nothing to probe)", () => {
    const { registry, crashed } = stubRegistry([
      row({ id: "nopid", pid: null, processAlive: undefined }),
    ])
    expect(runCrashDetectPass({ registry, crashDetectIntervalMs: THIRTY_SEC }).crashed).toBe(0)
    expect(crashed).toEqual([])
  })

  it("does NOT mark PTY / command / browser (non-agent-cli) sessions", () => {
    const { registry, crashed } = stubRegistry([
      row({ id: "pty", kind: "terminal", pty: true }),
      row({ id: "cmd", kind: "command" }),
      row({ id: "browser", kind: "browser" }),
    ])
    expect(runCrashDetectPass({ registry, crashDetectIntervalMs: THIRTY_SEC }).crashed).toBe(0)
    expect(crashed).toEqual([])
  })

  it("does NOT mark a non-running (already terminal) row", () => {
    const { registry, crashed } = stubRegistry([
      row({ id: "killed", status: "killed" }),
      row({ id: "exited", status: "exited" }),
      row({ id: "error", status: "error" }),
      row({ id: "starting", status: "starting" }),
    ])
    expect(runCrashDetectPass({ registry, crashDetectIntervalMs: THIRTY_SEC }).crashed).toBe(0)
    expect(crashed).toEqual([])
  })

  it("does NOT mark a remote/sandboxed session (no local pid is ours to probe)", () => {
    const { registry, crashed } = stubRegistry([row({ id: "remote", remote: true })])
    expect(runCrashDetectPass({ registry, crashDetectIntervalMs: THIRTY_SEC }).crashed).toBe(0)
    expect(crashed).toEqual([])
  })

  it("excludes rows the daemon does not serve (cross-process gate)", () => {
    const { registry, crashed } = stubRegistry([
      row({ id: "mine", workspaceSlug: "alpha" }),
      row({ id: "theirs", workspaceSlug: "beta" }),
    ])
    const summary = runCrashDetectPass({
      registry,
      crashDetectIntervalMs: THIRTY_SEC,
      isServed: d => d.workspaceSlug === "alpha",
    })
    expect(summary.candidates).toBe(1)
    expect(crashed).toEqual(["mine"])
  })

  it("is OFF only when the interval is explicitly non-positive/undefined", () => {
    const { registry: r0, crashed: crashed0 } = stubRegistry([row({ id: "a" })])
    expect(runCrashDetectPass({ registry: r0, crashDetectIntervalMs: 0 })).toEqual({
      enabled: false,
      candidates: 0,
      crashed: 0,
      ids: [],
    })
    expect(crashed0).toEqual([])

    const { registry: rU, crashed: crashedU } = stubRegistry([row({ id: "a" })])
    expect(
      runCrashDetectPass({ registry: rU, crashDetectIntervalMs: undefined }).enabled,
    ).toBe(false)
    expect(crashedU).toEqual([])
  })
})

// ── Layer 2: the crash action (real registry, faked-dead pid) ─────────────

function liveAgentSession(sessionId: string, closed: { value: boolean }): AgentSessionLike {
  return {
    sessionId,
    pid: 4242,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {
      closed.value = true
    },
  }
}

describe("registry.markCrashed — the crash action", () => {
  let tmp: string
  // Loosely typed on purpose: `vi.spyOn(process, "kill")`'s inferred
  // MockInstance<...> generic doesn't survive round-tripping through a
  // block-scoped `let` declared ahead of the call (the declared generic
  // default and the call-site-inferred signature aren't assignable to each
  // other under `tsc --noEmit`) — this variable only ever calls
  // `.mockRestore()`, so a structural type covering just that member
  // sidesteps the mismatch without touching runtime behavior.
  let killSpy: { mockRestore: () => void } | null = null
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "crash-detect-"))
  })
  afterEach(() => {
    killSpy?.mockRestore()
    killSpy = null
    rmSync(tmp, { recursive: true, force: true })
  })

  it("marks a live-descriptor/dead-process agent session: error + crashed, lastError/crashedAt stamped, row present + lazy-resumable, [crashed] banner appended, session:exited emitted once", () => {
    const bus = createSessionEventBus()
    const exited = vi.fn()
    bus.on("session:exited", exited)
    const closed = { value: false }
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: bus,
    })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", closed),
      adapterSlug: "claude-code",
    })
    expect(desc.pid).toBe(4242)

    // Observe the appended banner via attach() (backfill + live subscribe).
    const lines: Array<{ line: string; stream: string }> = []
    const detach = reg.attach(desc.id, (line, stream) => lines.push({ line, stream }))

    // Fake the OS reporting the pid gone — same technique as
    // sessions.test.ts's "liveness" suite.
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })
    expect(reg.get(desc.id)?.processAlive).toBe(false)

    expect(reg.markCrashed(desc.id)).toBe(true)

    const after = reg.get(desc.id)!
    expect(after.status).toBe("error")
    expect(after.endedReason).toBe("crashed")
    expect(after.crashedAt).toBeTruthy()
    expect(after.lastError).toContain("4242")
    expect(after.lastError).toContain("crashed")
    expect(reg.list().find(s => s.id === desc.id)).toBeDefined()
    // adapterSessionId/cwd intact ⇒ still lazy-resumable.
    expect(isResumable(after)).toBe(true)
    // Adapter binding freed.
    expect(closed.value).toBe(true)

    expect(lines.some(l => l.stream === "stderr" && l.line.includes("[crashed]"))).toBe(true)
    expect(lines.some(l => l.line.includes("4242"))).toBe(true)

    expect(exited).toHaveBeenCalledTimes(1)
    expect(exited).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:exited",
        sessionId: desc.id,
        status: "error",
        reason: "crashed",
      }),
    )

    detach?.()
    reg.shutdown()
  })

  it("is idempotent: a second markCrashed call on an already-crashed row is a no-op", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    expect(reg.markCrashed(desc.id)).toBe(true)
    expect(reg.markCrashed(desc.id)).toBe(false)
    reg.shutdown()
  })

  it("refuses (no-op) a non-agent-cli, non-running, or unknown row", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.kill(desc.id)
    // Already terminal ⇒ markCrashed is a no-op.
    expect(reg.markCrashed(desc.id)).toBe(false)
    // Unknown id ⇒ false.
    expect(reg.markCrashed("nope")).toBe(false)
    reg.shutdown()
  })

  it("end-to-end via runCrashDetectPass: a dead-pid agent session is discovered and marked by the sweep", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })
    const summary = runCrashDetectPass({ registry: reg, crashDetectIntervalMs: 30_000 })
    expect(summary.crashed).toBe(1)
    expect(summary.ids).toEqual([desc.id])
    expect(reg.get(desc.id)?.status).toBe("error")
    expect(reg.get(desc.id)?.endedReason).toBe("crashed")
    reg.shutdown()
  })
})
