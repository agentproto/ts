import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  isResumable,
  type AgentSessionLike,
} from "../sessions.js"
import { runCrashDetectPass } from "../crash-reaper.js"
import { createSessionEventBus } from "../session-event-bus.js"

/**
 * Regression: a dead ACP connection must not be reported as a live session.
 *
 * Field evidence (2026-09-25, `sess_950d1251`, claude-code): the ACP
 * connection closed at ~15:04Z — an `error` event carrying "ACP connection
 * closed", then a turn-end with reason "aborted". The daemon went on
 * reporting `status: "running"`, `alive: true` for 40+ minutes; UIs showed
 * "Idle · live"; `agent_prompt` went nowhere; `session_restart` failed with
 * the same "ACP connection closed".
 *
 * Nothing caught it because BOTH liveness signals were blind to it: the
 * 30s crash-detect sweep probes only the pid (`process.kill(pid, 0)`), and
 * the wrapper PROCESS was still alive — only its stdio stream had died.
 *
 * The fake session below models exactly that: a live `pid`, and an
 * `isConnected()`/`onDisconnect()` pair driven independently of it. Every
 * test here keeps the process "alive" so the pid axis can never be what
 * rescues the assertion.
 */

/** A fake agent session whose TRANSPORT can be killed without touching its
 *  process — the shape the real bug takes. `closeConnection()` is the test's
 *  stand-in for the ACP SDK aborting its connection signal. */
function transportSession(sessionId: string): AgentSessionLike & {
  closeConnection(): void
  closed: boolean
} {
  let connected = true
  const listeners: Array<(err: Error) => void> = []
  const session = {
    sessionId,
    pid: 4242,
    closed: false,
    isConnected: () => connected,
    onDisconnect(listener: (err: Error) => void) {
      if (!connected) listener(new Error("ACP connection closed"))
      else listeners.push(listener)
    },
    closeConnection() {
      if (!connected) return
      connected = false
      for (const l of listeners.splice(0)) l(new Error("ACP connection closed"))
    },
    async *send() {
      yield { kind: "turn-end" as const, reason: "completed" as const }
    },
    async cancel() {},
    async close() {
      session.closed = true
      connected = false
    },
  }
  return session
}

/** A conventional healthy session — no transport-liveness surface at all,
 *  the shape of a sandbox proxy or a print-arm adapter. */
function plainSession(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    pid: 4242,
    async *send() {
      yield { kind: "turn-end" as const, reason: "completed" as const }
    },
    async cancel() {},
    async close() {},
  }
}

describe("adapter transport death", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "adapter-disconnect-"))
    // Every session here claims pid 4242, which doesn't exist on the test
    // box — so without this the PROCESS axis would report "dead" and be what
    // condemns each row, proving nothing about the transport axis under
    // test. Pin the pid probe to "alive" to model the real bug exactly: a
    // wrapper process that is very much still running.
    vi.spyOn(process, "kill").mockReturnValue(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(tmp, { recursive: true, force: true })
  })

  function registry(bus?: ReturnType<typeof createSessionEventBus>) {
    return createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      ...(bus ? { sessionEvents: bus } : {}),
    })
  }

  it("projects transport liveness onto the descriptor at read time", () => {
    const reg = registry()
    const session = transportSession("acp-1")
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "claude-code",
    })
    expect(reg.get(desc.id)?.adapterConnected).toBe(true)
    expect(reg.list().find(d => d.id === desc.id)?.adapterConnected).toBe(true)
    reg.shutdown()
  })

  it("leaves adapterConnected ABSENT for a session with no transport to lose", () => {
    // Absent must never read as "disconnected" — a sandbox proxy or print-arm
    // session would otherwise be crash-marked on every sweep.
    const reg = registry()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: plainSession("acp-1"),
      adapterSlug: "claude-code",
    })
    expect(reg.get(desc.id)).not.toHaveProperty("adapterConnected")
    expect(runCrashDetectPass({ registry: reg, crashDetectIntervalMs: 30_000 }).crashed).toBe(0)
    expect(reg.get(desc.id)?.status).toBe("running")
    reg.shutdown()
  })

  it("marks the session crashed the INSTANT its connection closes — process still alive", () => {
    const bus = createSessionEventBus()
    const exited = vi.fn()
    bus.on("session:exited", exited)
    const reg = registry(bus)
    const session = transportSession("acp-1")
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "claude-code",
    })
    expect(reg.get(desc.id)?.status).toBe("running")

    session.closeConnection()

    // No sweep, no prompt, no timer — the push watcher did it.
    const after = reg.get(desc.id)!
    expect(after.status).toBe("error")
    expect(after.endedReason).toBe("crashed")
    expect(after.lastError).toContain("connection closed")
    // `alive` is the field every UI renders as "live" — the 40-minute lie.
    expect(after.alive).toBe(false)
    expect(exited).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: desc.id, reason: "crashed" }),
    )
    // Dead but recoverable: binding freed, resume essentials intact.
    expect(isResumable(after)).toBe(true)
    reg.shutdown()
  })

  it("is caught by the crash-detect sweep too, for an adapter with no disconnect push", () => {
    // Same death, pull path only: `isConnected()` without `onDisconnect()`.
    // This is the belt to the push watcher's braces — and the direct answer
    // to "why didn't the 30s sweep catch it?" (it only looked at the pid).
    const reg = registry()
    const session = transportSession("acp-1")
    const pullOnly: AgentSessionLike = {
      ...session,
      onDisconnect: undefined,
      isConnected: () => session.isConnected!(),
      send: session.send.bind(session),
      cancel: session.cancel.bind(session),
      close: session.close.bind(session),
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: pullOnly,
      adapterSlug: "claude-code",
    })
    session.closeConnection()

    // Still "running" — nothing pushed. The pid is alive, so the OLD policy
    // would have found zero candidates here.
    expect(reg.get(desc.id)?.status).toBe("running")
    expect(reg.get(desc.id)?.processAlive).toBe(true)

    const summary = runCrashDetectPass({ registry: reg, crashDetectIntervalMs: 30_000 })
    expect(summary.crashed).toBe(1)
    expect(summary.ids).toEqual([desc.id])
    expect(reg.get(desc.id)?.status).toBe("error")
    expect(reg.get(desc.id)?.lastError).toContain("connection closed")
    reg.shutdown()
  })

  it("does NOT crash-mark on the disconnect an intentional kill() causes", () => {
    // `kill()` closes the connection itself, which fires the same watcher.
    // The row must stay `killed` — a deliberate teardown is not a crash.
    const reg = registry()
    const session = transportSession("acp-1")
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "claude-code",
    })
    expect(reg.kill(desc.id)).toBe(true)
    session.closeConnection()

    const after = reg.get(desc.id)!
    expect(after.status).toBe("killed")
    expect(after.endedReason).toBeUndefined()
    expect(after.lastError).toBeUndefined()
    reg.shutdown()
  })

  it("does NOT crash-mark on the disconnect an idle reap causes", () => {
    const reg = registry()
    const session = transportSession("acp-1")
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "claude-code",
    })
    expect(reg.reapIdle(desc.id, 60_000)).toBe(true)
    session.closeConnection()

    expect(reg.get(desc.id)?.endedReason).toBe("idle-reaped")
    reg.shutdown()
  })

  it("a prompt to a transport-dead session resumes it in place rather than dispatching into a dead socket", async () => {
    // The `agent_prompt goes nowhere` half of the bug. Drive the pull-only
    // shape so the prompt path itself has to do the reconciliation.
    const dead = transportSession("acp-1")
    const pullOnly: AgentSessionLike = {
      sessionId: dead.sessionId,
      pid: dead.pid,
      isConnected: () => dead.isConnected!(),
      send: dead.send.bind(dead),
      cancel: dead.cancel.bind(dead),
      close: dead.close.bind(dead),
    }
    const fresh = transportSession("acp-2")
    const resumeAgent = vi.fn(async () => fresh)
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      resumeAgent,
    })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: pullOnly,
      adapterSlug: "claude-code",
    })

    dead.closeConnection()
    await reg.sendPrompt(desc.id, "are you there?")

    expect(resumeAgent).toHaveBeenCalledTimes(1)
    // Same row, revived on a fresh adapter session.
    const after = reg.get(desc.id)!
    expect(after.status).toBe("running")
    expect(after.adapterSessionId).toBe("acp-2")
    expect(after.adapterConnected).toBe(true)
    reg.shutdown()
  })

  it("a stale connection's late disconnect does not kill the session that replaced it", async () => {
    // A resumed row holds a NEW session; the OLD one's abort can still be in
    // flight. Crash-marking on it would take down a perfectly healthy
    // session on the strength of its dead predecessor.
    const dead = transportSession("acp-1")
    const fresh = transportSession("acp-2")
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      resumeAgent: async () => fresh,
    })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: dead,
      adapterSlug: "claude-code",
    })
    dead.closeConnection()
    await reg.sendPrompt(desc.id, "revive")
    expect(reg.get(desc.id)?.status).toBe("running")

    // The old connection settles its teardown late.
    dead.closeConnection()
    await dead.close()

    expect(reg.get(desc.id)?.status).toBe("running")
    expect(reg.get(desc.id)?.adapterSessionId).toBe("acp-2")
    reg.shutdown()
  })
})
