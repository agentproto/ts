import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionDescriptor,
} from "../sessions.js"
import {
  runStallWatchdogPass,
  type StallWatchdogRegistry,
} from "../stall-watchdog.js"
import { createSessionEventBus } from "../session-event-bus.js"

/**
 * Turn-liveness watchdog (turn-liveness-watchdog chantier).
 *
 * Two layers, tested separately, mirroring crash-reaper.test.ts:
 *   1. `runStallWatchdogPass` — the POLICY (which busy rows have gone
 *      silent mid-turn long enough, and are NOT legitimately blocked).
 *      Driven against a stub registry so candidate selection is
 *      deterministic.
 *   2. `registry.markStalled` / `registry.clearStalled` — the trip/clear
 *      ACTIONS (stamp/clear `stalledSinceMs`, emit `session:stalled` /
 *      `session:stall-cleared`), plus the event-driven clearing hooks
 *      (`pulseActivity`, turn `finally`). Driven against a real registry
 *      with a hung fake agent session whose turn never naturally ends.
 */

// ── Layer 1: candidate-selection policy (stub registry) ───────────────────

const FIVE_MIN = 5 * 60_000
const NOW = Date.parse("2026-08-09T12:00:00Z")
const TEN_MIN_AGO = new Date(NOW - 10 * 60_000).toISOString()
const ONE_MIN_AGO = new Date(NOW - 60_000).toISOString()

/** A base LOCAL agent-cli row, busy and silent well past the default
 *  threshold — the default candidate shape. Override per case. */
function row(over: Partial<SessionDescriptor> & { id: string }): SessionDescriptor {
  return {
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude (agent)",
    pid: 4242,
    status: "running",
    busy: true,
    startedAt: TEN_MIN_AGO,
    lastActivityAt: TEN_MIN_AGO,
    adapterSlug: "claude-code",
    adapterSessionId: `acp-${over.id}`,
    cwd: "/tmp",
    ...over,
  }
}

/** A stub registry that records every `markStalled` call and always
 *  succeeds — so a test asserts EXACTLY which rows the policy selected. */
function stubRegistry(rows: SessionDescriptor[]): {
  registry: StallWatchdogRegistry
  stalled: Array<{ id: string; stalledSinceMs: number }>
} {
  const stalled: Array<{ id: string; stalledSinceMs: number }> = []
  const registry: StallWatchdogRegistry = {
    list: () => rows,
    markStalled: (id, stalledSinceMs) => {
      stalled.push({ id, stalledSinceMs })
      return true
    },
  }
  return { registry, stalled }
}

describe("runStallWatchdogPass — candidate selection", () => {
  it("flags a busy, unblocked agent-cli session silent past the threshold", () => {
    const { registry, stalled } = stubRegistry([row({ id: "dead-stream" })])
    const summary = runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW })
    expect(summary).toEqual({ enabled: true, candidates: 1, stalled: 1, ids: ["dead-stream"] })
    // Dated from the last real activity, not `now` — a consumer computes
    // "silent for" as now - stalledSinceMs.
    expect(stalled).toEqual([{ id: "dead-stream", stalledSinceMs: Date.parse(TEN_MIN_AGO) }])
  })

  it("does NOT flag a session that isn't busy (idle silence is not a stall)", () => {
    const { registry, stalled } = stubRegistry([row({ id: "idle", busy: false })])
    expect(
      runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW }).stalled,
    ).toBe(0)
    expect(stalled).toEqual([])
  })

  it("does NOT flag a session legitimately blockedOn a subagent or command — the false-positive this predicate is designed to never trip on", () => {
    const { registry, stalled } = stubRegistry([
      row({ id: "blocked-subagent", blockedOn: "subagent" }),
      row({ id: "blocked-command", blockedOn: "command" }),
    ])
    expect(
      runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW }).stalled,
    ).toBe(0)
    expect(stalled).toEqual([])
  })

  it("does NOT flag a row whose currentPhase is an ACTIVE tool call — a long pnpm install is expected silence, not a stall (even when classifyBlockedOn never maps the tool name into blockedOn)", () => {
    const { registry, stalled } = stubRegistry([
      row({ id: "installing", currentPhase: "tool-call:install_packages" }),
      row({ id: "mcp-tool", currentPhase: "tool-call:mcp__agentproto__workspace_sync" }),
    ])
    expect(
      runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW }).stalled,
    ).toBe(0)
    expect(stalled).toEqual([])
  })

  it("does NOT flag a session already carrying stalledSinceMs — the sweep only ever adds the flag", () => {
    const { registry, stalled } = stubRegistry([
      row({ id: "already-flagged", stalledSinceMs: Date.parse(TEN_MIN_AGO) }),
    ])
    expect(
      runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW }).stalled,
    ).toBe(0)
    expect(stalled).toEqual([])
  })

  it("does NOT flag a session silent for less than the threshold", () => {
    const { registry, stalled } = stubRegistry([
      row({ id: "recent", lastActivityAt: ONE_MIN_AGO }),
    ])
    expect(
      runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW }).stalled,
    ).toBe(0)
    expect(stalled).toEqual([])
  })

  it("falls back to startedAt when lastActivityAt is absent", () => {
    const { registry, stalled } = stubRegistry([
      row({ id: "never-pulsed", lastActivityAt: undefined, startedAt: TEN_MIN_AGO }),
    ])
    const summary = runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW })
    expect(summary.stalled).toBe(1)
    expect(stalled).toEqual([{ id: "never-pulsed", stalledSinceMs: Date.parse(TEN_MIN_AGO) }])
  })

  it("does NOT flag a row whose activity timestamp can't be parsed", () => {
    const { registry, stalled } = stubRegistry([
      row({ id: "unparseable", lastActivityAt: "not-a-date", startedAt: "also-not-a-date" }),
    ])
    expect(
      runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW }).stalled,
    ).toBe(0)
    expect(stalled).toEqual([])
  })

  it("does NOT flag PTY / command / browser (non-agent-cli) sessions", () => {
    const { registry, stalled } = stubRegistry([
      row({ id: "pty", kind: "terminal", pty: true }),
      row({ id: "cmd", kind: "command" }),
      row({ id: "browser", kind: "browser" }),
    ])
    expect(
      runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW }).stalled,
    ).toBe(0)
    expect(stalled).toEqual([])
  })

  it("does NOT flag a non-running (already terminal) row", () => {
    const { registry, stalled } = stubRegistry([
      row({ id: "killed", status: "killed" }),
      row({ id: "exited", status: "exited" }),
      row({ id: "error", status: "error" }),
      row({ id: "starting", status: "starting", busy: false }),
    ])
    expect(
      runStallWatchdogPass({ registry, turnStallAfterMs: FIVE_MIN, now: () => NOW }).stalled,
    ).toBe(0)
    expect(stalled).toEqual([])
  })

  it("excludes rows the daemon does not serve (cross-process gate)", () => {
    const { registry, stalled } = stubRegistry([
      row({ id: "mine", workspaceSlug: "alpha" }),
      row({ id: "theirs", workspaceSlug: "beta" }),
    ])
    const summary = runStallWatchdogPass({
      registry,
      turnStallAfterMs: FIVE_MIN,
      now: () => NOW,
      isServed: d => d.workspaceSlug === "alpha",
    })
    expect(summary.candidates).toBe(1)
    expect(stalled.map(s => s.id)).toEqual(["mine"])
  })

  it("is OFF only when the threshold is explicitly non-positive/undefined", () => {
    const { registry: r0, stalled: stalled0 } = stubRegistry([row({ id: "a" })])
    expect(runStallWatchdogPass({ registry: r0, turnStallAfterMs: 0, now: () => NOW })).toEqual({
      enabled: false,
      candidates: 0,
      stalled: 0,
      ids: [],
    })
    expect(stalled0).toEqual([])

    const { registry: rU, stalled: stalledU } = stubRegistry([row({ id: "a" })])
    expect(
      runStallWatchdogPass({ registry: rU, turnStallAfterMs: undefined, now: () => NOW }).enabled,
    ).toBe(false)
    expect(stalledU).toEqual([])
  })
})

// ── Layer 2: the trip/clear actions + event-driven clearing (real registry) ─

function hungAgentSession(
  sessionId: string,
  opts?: { toolCall?: { toolCallId: string; toolName: string }; hangUntil?: Promise<void> },
): AgentSessionLike {
  return {
    sessionId,
    async *send() {
      if (opts?.toolCall) {
        yield { kind: "tool-call", toolCallId: opts.toolCall.toolCallId, toolName: opts.toolCall.toolName }
      }
      await (opts?.hangUntil ?? new Promise<void>(() => {})) // stream dies mid-turn — never yields again
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

function idleAgentSession(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** A box session whose legacy relay has delivered exactly one flattened ring
 *  line, a `[tool] bash` announcement with no matching `[tool-result]`, and
 *  then gone quiet: a long foreground build inside the box. */
function relayedOpenToolAgentSession(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    async *send() {
      yield {
        kind: "text-delta",
        text: '\x1b[36m[tool] bash {"cwd":"/home/user/.worktrees/x"}\x1b[0m\n',
      }
      await new Promise<void>(() => {}) // the tool keeps running; no further relay events
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

describe("registry.markStalled / clearStalled — the trip/clear actions", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "stall-watchdog-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("stamps stalledSinceMs and emits session:stalled on a live, busy, unblocked row", async () => {
    const bus = createSessionEventBus()
    const stalled = vi.fn()
    bus.on("session:stalled", stalled)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hungAgentSession("acp-hung"),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.get(desc.id)?.busy).toBe(true)

    expect(reg.markStalled(desc.id, 12345)).toBe(true)
    expect(reg.get(desc.id)?.stalledSinceMs).toBe(12345)
    expect(stalled).toHaveBeenCalledTimes(1)
    expect(stalled).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:stalled", sessionId: desc.id, stalledSinceMs: 12345 }),
    )

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("is idempotent: a second markStalled call on an already-flagged row is a no-op", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hungAgentSession("acp-hung"),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.markStalled(desc.id, 1)).toBe(true)
    expect(reg.markStalled(desc.id, 2)).toBe(false)
    expect(reg.get(desc.id)?.stalledSinceMs).toBe(1)

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("refuses a row that isn't busy, isn't running, or is unknown", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const idle = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-idle"),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.get(idle.id)?.busy).toBe(false) // sanity: the turn already finished
    expect(reg.markStalled(idle.id, 1)).toBe(false)

    reg.kill(idle.id)
    expect(reg.markStalled(idle.id, 1)).toBe(false) // no longer running

    expect(reg.markStalled("nope", 1)).toBe(false) // unknown id
    reg.shutdown()
  })

  it("refuses a row with a tool call in flight whose name does NOT classify into blockedOn, the action-level guard covers a long `pnpm install` announced by a per-adapter tool name", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hungAgentSession("acp-installing", {
        toolCall: { toolCallId: "tc1", toolName: "install_packages" },
      }),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.get(desc.id)?.busy).toBe(true)
    const live = reg.get(desc.id)
    expect(live?.currentPhase).toBe("tool-call:install_packages")
    expect(reg.markStalled(desc.id, 1)).toBe(false)
    expect(reg.get(desc.id)?.stalledSinceMs).toBeUndefined()

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("refuses a row legitimately blockedOn a command — the action-level guard mirrors the sweep's predicate", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hungAgentSession("acp-blocked", {
        toolCall: { toolCallId: "tc1", toolName: "command_execute" },
      }),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.get(desc.id)?.busy).toBe(true)
    expect(reg.get(desc.id)?.blockedOn).toBe("command")
    expect(reg.markStalled(desc.id, 1)).toBe(false)

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("does NOT flag a box session whose last relayed event is an unmatched [tool] line older than the threshold", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      remote: true,
      agentSession: relayedOpenToolAgentSession("acp-box-installing"),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.get(desc.id)?.busy).toBe(true)
    // The flattened relay's `[tool] bash` line must become an in-flight tool
    // call, the same phase a structured `tool-call` event produces locally.
    expect(reg.get(desc.id)?.currentPhase).toBe("tool-call:bash")
    // The action layer agrees: an open tool call is expected silence, so it
    // refuses the mark even when called directly.
    expect(reg.markStalled(desc.id, 1)).toBe(false)

    const lastActivity = Date.parse(reg.get(desc.id)?.lastActivityAt ?? new Date().toISOString())
    const summary = runStallWatchdogPass({
      registry: reg,
      turnStallAfterMs: FIVE_MIN,
      now: () => lastActivity + 10 * 60_000,
    })
    expect(summary.candidates).toBe(0)
    expect(summary.stalled).toBe(0)

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("clearStalled clears the flag and emits session:stall-cleared only when it was actually set", async () => {
    const bus = createSessionEventBus()
    const cleared = vi.fn()
    bus.on("session:stall-cleared", cleared)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hungAgentSession("acp-hung"),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)

    // Not flagged yet ⇒ no-op, no event.
    expect(reg.clearStalled(desc.id)).toBe(false)
    expect(cleared).not.toHaveBeenCalled()

    reg.markStalled(desc.id, 1)
    expect(reg.clearStalled(desc.id)).toBe(true)
    expect(reg.get(desc.id)?.stalledSinceMs).toBeUndefined()
    expect(cleared).toHaveBeenCalledTimes(1)
    expect(cleared).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:stall-cleared", sessionId: desc.id }),
    )

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("pulseActivity clears an active stall flag — new adapter traffic disproves the stall claim", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hungAgentSession("acp-hung"),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.markStalled(desc.id, 1)).toBe(true)

    reg.pulseActivity(desc.id)
    expect(reg.get(desc.id)?.stalledSinceMs).toBeUndefined()

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("clears a stall flag when the turn ends — busy flips false, so mid-turn-and-silent no longer holds", async () => {
    let resolveHang: () => void = () => {}
    const hangUntil = new Promise<void>(res => {
      resolveHang = res
    })
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hungAgentSession("acp-hung", { hangUntil }),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.markStalled(desc.id, 1)).toBe(true)

    resolveHang()
    await sleep(20)
    expect(reg.get(desc.id)?.busy).toBe(false)
    expect(reg.get(desc.id)?.stalledSinceMs).toBeUndefined()

    reg.shutdown()
  })

  it("end-to-end via runStallWatchdogPass: a busy, unblocked, silent session is discovered and flagged by the sweep", async () => {
    const bus = createSessionEventBus()
    const stalled = vi.fn()
    bus.on("session:stalled", stalled)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hungAgentSession("acp-hung"),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.get(desc.id)?.busy).toBe(true)

    const future = () => Date.now() + FIVE_MIN + 60_000
    const summary = runStallWatchdogPass({ registry: reg, turnStallAfterMs: FIVE_MIN, now: future })
    expect(summary.stalled).toBe(1)
    expect(summary.ids).toEqual([desc.id])
    expect(reg.get(desc.id)?.stalledSinceMs).toBeTypeOf("number")
    expect(stalled).toHaveBeenCalledTimes(1)
    expect(stalled).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:stalled", sessionId: desc.id }),
    )

    // A second sweep tick must not re-flag (or re-emit for) an already-flagged row.
    const again = runStallWatchdogPass({ registry: reg, turnStallAfterMs: FIVE_MIN, now: future })
    expect(again.stalled).toBe(0)
    expect(stalled).toHaveBeenCalledTimes(1)

    reg.kill(desc.id)
    reg.shutdown()
  })
})
