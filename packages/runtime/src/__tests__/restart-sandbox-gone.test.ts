/**
 * `restartPolicy.on` including `"sandbox-gone"` — the fresh-box move for a
 * dead box session whose BOX is gone (restart-scheduler's sandbox-gone
 * branch). Layered over the same registry/event-bus machinery the classic
 * crash-restart e2e tests use, with the gateway's fresh-box executor stubbed
 * (the real one is `restartAgentSession` → `spawnOnFreshBox`, covered by
 * `session-restart-sandbox.test.ts`):
 *
 *   1. box gone + policy → the fresh-box hook fires once, the rolling window
 *      carries onto the fresh row, and the NEXT death is capped;
 *   2. box gone without the opt-in → the row stays dead, hook never fires;
 *   3. a blocked move (no workspace remote, …) → exactly one `[sandbox-gone]`
 *      notice, schedule consumed, no retry loop;
 *   4. a NON-box crash → in-place revival unchanged, hook never consulted;
 *   5. `sandbox-gone.ts`'s classifier itself (evidence / ledger / one-shot
 *      provider probe).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  SANDBOX_GONE_DEFAULT_RESTART_POLICY,
  type AgentSessionLike,
  type AgentStreamEvent,
  type RestartPolicy,
  type SessionsRegistry,
} from "../sessions.js"
import { createRestartScheduler, runRestartSweepPass } from "../restart-scheduler.js"
import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import { hasSandboxGoneEvidence, isBoxGoneMessage, isSandboxBoxGone } from "../sandbox-gone.js"
import { sessionTranscriptDir } from "../transcript-writer.js"

const SANDBOX_POLICY: RestartPolicy = {
  on: ["sandbox-gone"],
  maxRetries: 1,
  windowMs: 60_000,
  baseDelayMs: 10,
  factor: 2,
  maxDelayMs: 50,
}

function liveAgentSession(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    pid: 4242,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

function readTranscript(tmp: string, id: string): string {
  try {
    return readFileSync(join(sessionTranscriptDir(id, tmp), "events.jsonl"), "utf8")
  } catch {
    return ""
  }
}

describe("restartPolicy \"sandbox-gone\": fresh-box move for a dead box session", () => {
  let tmp: string
  let bus: SessionEventBus
  let reg: SessionsRegistry
  let scheduler: { dispose(): void }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sandbox-gone-restart-"))
    bus = createSessionEventBus()
  })

  afterEach(() => {
    scheduler?.dispose()
    reg?.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  function setupReg(opts: {
    hook?: (input: {
      sessionId: string
      prev: import("../sessions.js").SessionDescriptor
    }) => Promise<{ ok: true; newSessionId: string } | { ok: false; blocker: string }>
    resumeAgent?: () => Promise<AgentSessionLike>
  } = {}): { hookCalls: string[]; counters: { resumeCalls: number } } {
    const hookCalls: string[] = []
    const counters = { resumeCalls: 0 }
    reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: bus,
      ...(opts.hook || opts.hook === undefined
        ? {
            restartSandboxGone: async input => {
              hookCalls.push(input.sessionId)
              if (opts.hook) return opts.hook(input)
              // Default stub executor: supersede the old row and mint a fresh
              // box session, mirroring `restartAgentSession`'s fresh-box move.
              reg.kill(input.prev.id, "SIGTERM", "restarted")
              const fresh = reg.spawnAgent({
                workspaceSlug: "default",
                cwd: "/tmp",
                agentSession: liveAgentSession(`fresh-${hookCalls.length}`),
                adapterSlug: "fake-cli",
                commandPreview: "sandbox:fake → fake-cli",
                remote: true,
                sandboxId: `sbx_fresh_${hookCalls.length}`,
                ...(input.prev.restartPolicy
                  ? { restartPolicy: input.prev.restartPolicy }
                  : {}),
              })
              return { ok: true, newSessionId: fresh.id }
            },
          }
        : {}),
      resumeAgent: async () => {
        counters.resumeCalls++
        return opts.resumeAgent
          ? opts.resumeAgent()
          : liveAgentSession("resumed-acp")
      },
    })
    scheduler = createRestartScheduler({ registry: reg, sessionEvents: bus })
    return { hookCalls, counters }
  }

  function spawnBoxRow(policy?: RestartPolicy): string {
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/home/user",
      agentSession: liveAgentSession("box-acp"),
      adapterSlug: "fake-cli",
      commandPreview: "sandbox:fake → fake-cli",
      remote: true,
      sandboxId: "sbx_dying",
      ...(policy ? { restartPolicy: policy } : {}),
    })
    return desc.id
  }

  /** The death the boot reattach pass stamps when the provider says the box
   *  (or its session) no longer exists: status killed/error +
   *  `endedReason:"sandbox_gone"` + `session:exited`. */
  function dieBoxGone(id: string): void {
    const d = reg.get(id)!
    d.status = "error"
    d.endedReason = "sandbox_gone"
    bus.emit({
      type: "session:exited",
      sessionId: id,
      status: "error",
      reason: "sandbox_gone",
      ts: new Date().toISOString(),
    })
  }

  async function sweepPastSchedule(id: string): Promise<void> {
    const landed = Date.parse(reg.get(id)!.nextRestartAt!)
    await runRestartSweepPass({
      registry: reg,
      restartSweepIntervalMs: 1_000,
      now: () => landed + 1,
    })
  }

  it("box gone + policy → the fresh-box hook fires once; the carried window caps the NEXT death", async () => {
    const { hookCalls } = setupReg()
    const row1 = spawnBoxRow(SANDBOX_POLICY)

    dieBoxGone(row1)
    await vi.waitFor(() => expect(reg.get(row1)!.nextRestartAt).toBeTruthy())
    expect(reg.get(row1)!.nextRestartFreshBox).toBe(true)

    await sweepPastSchedule(row1)
    expect(hookCalls).toEqual([row1])
    // The corpse's schedule is consumed; the fresh row wears the window.
    expect(reg.get(row1)!.nextRestartAt).toBeUndefined()
    const row2 = reg.list().find(d => d.sandboxId === "sbx_fresh_1")!
    expect(row2.restartAttempts).toBe(1)
    expect(row2.recentRestartAts).toHaveLength(1)

    // Second box death: 1 recent restart within windowMs >= maxRetries=1 →
    // the crash-loop cap gives up instead of scheduling another move.
    dieBoxGone(row2.id)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(reg.get(row2.id)!.nextRestartAt).toBeUndefined()
    expect(hookCalls).toEqual([row1]) // never a second move
    await vi
      .waitFor(() => expect(readTranscript(tmp, row2.id)).toContain("[crash-loop]"))
  })

  it("box gone WITHOUT the opt-in → stays dead, the hook never fires", async () => {
    const { hookCalls, counters } = setupReg()
    const noPolicy = spawnBoxRow(undefined)
    const classicOnly = spawnBoxRow({ ...SANDBOX_POLICY, on: ["crashed", "error"] })

    dieBoxGone(noPolicy)
    dieBoxGone(classicOnly)
    await new Promise(resolve => setTimeout(resolve, 5))

    expect(reg.get(noPolicy)!.nextRestartAt).toBeUndefined()
    expect(reg.get(classicOnly)!.nextRestartAt).toBeUndefined()
    await runRestartSweepPass({ registry: reg, restartSweepIntervalMs: 1_000 })
    expect(hookCalls).toEqual([])
    expect(counters.resumeCalls).toBe(0)
  })

  it("a blocked move → one `[sandbox-gone]` notice, schedule consumed, no retry loop", async () => {
    const { hookCalls } = setupReg({
      hook: async () => ({
        ok: false as const,
        blocker: 'workspace "agentproto" has no remote configured, so a new box has nothing to clone',
      }),
    })
    const row1 = spawnBoxRow(SANDBOX_POLICY)

    dieBoxGone(row1)
    await vi.waitFor(() => expect(reg.get(row1)!.nextRestartAt).toBeTruthy())
    await sweepPastSchedule(row1)

    expect(hookCalls).toEqual([row1])
    expect(reg.get(row1)!.nextRestartAt).toBeUndefined()
    expect(reg.get(row1)!.nextRestartFreshBox).toBeUndefined()
    await vi.waitFor(() => {
      const text = readTranscript(tmp, row1)
      expect(text).toContain("[sandbox-gone] cannot move this session to a fresh box")
      expect(text).toContain("has no remote configured")
      // Exactly ONE notice — never a loop.
      expect(text.match(/\[sandbox-gone\] cannot move this session to a fresh box/g)).toHaveLength(1)
    })

    // Later sweep ticks find nothing to re-attempt.
    await runRestartSweepPass({ registry: reg, restartSweepIntervalMs: 1_000 })
    expect(hookCalls).toEqual([row1])
  })

  it("a throwing hook is treated as a blocked move — one notice, no loop", async () => {
    const { hookCalls } = setupReg({
      hook: async () => {
        throw new Error('restartAgentSession: sandbox "sbx_dying" expired and it cannot be restarted on a fresh box: workspace "ws" is no longer registered')
      },
    })
    const row1 = spawnBoxRow(SANDBOX_POLICY)
    dieBoxGone(row1)
    await vi.waitFor(() => expect(reg.get(row1)!.nextRestartAt).toBeTruthy())
    await sweepPastSchedule(row1)
    expect(hookCalls).toEqual([row1])
    await vi
      .waitFor(() => expect(readTranscript(tmp, row1)).toContain("[sandbox-gone] cannot move this session to a fresh box"))
  })

  it("a NON-box crash → in-place revival unchanged, the fresh-box hook never consulted", async () => {
    const { hookCalls, counters } = setupReg()
    const local = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("local-acp"),
      adapterSlug: "fake-cli",
      restartPolicy: { ...SANDBOX_POLICY, on: ["crashed", "sandbox-gone"] },
    })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })
    expect(reg.markCrashed(local.id)).toBe(true)
    killSpy.mockRestore()

    // Classic in-place schedule — synchronous, and NOT a fresh-box move.
    expect(reg.get(local.id)!.nextRestartAt).toBeTruthy()
    expect(reg.get(local.id)!.nextRestartFreshBox).toBeUndefined()

    const landed = Date.parse(reg.get(local.id)!.nextRestartAt!)
    await runRestartSweepPass({
      registry: reg,
      restartSweepIntervalMs: 1_000,
      now: () => landed + 1,
    })
    expect(counters.resumeCalls).toBe(1)
    expect(hookCalls).toEqual([])
    expect(reg.get(local.id)!.status).toBe("running")
  })
})

// ── sandbox-gone.ts: the classifier ─────────────────────────────────────────

describe("sandbox-gone classification", () => {
  const base = {
    kind: "agent-cli" as const,
    workspaceSlug: "default",
    command: "sandbox:e2b → claude-code",
    pid: null,
    status: "error" as const,
    startedAt: "2026-10-14T00:00:00Z",
    adapterSlug: "claude-code",
    cwd: "/home/user",
    sandboxId: "sbx_1",
    remote: true,
  }

  it("the reattach pass's endedReason:sandbox_gone is definitive", () => {
    expect(hasSandboxGoneEvidence({ ...base, endedReason: "sandbox_gone" })).toBe(true)
  })

  it("recognises the recorded box-gone death messages (lifetime cap / watchdog / connect)", () => {
    expect(isBoxGoneMessage("Sandbox is probably not running anymore")).toBe(true)
    expect(
      isBoxGoneMessage(
        'sandbox proxy: the box daemon for remote session "s1" failed its health check 3 times in a row (crash, OOM, or the box is gone).',
      ),
    ).toBe(true)
    expect(
      isBoxGoneMessage(
        "sandbox proxy: 5 consecutive poll failures against the box daemon (session \"s1\") — giving up. Last error: connect ECONNREFUSED",
      ),
    ).toBe(true)
    expect(isBoxGoneMessage('restartAgentSession: sandbox "sbx_1" expired or is unreachable')).toBe(false)
    // Ordinary turn errors / adapter crashes are NOT box-gone.
    expect(isBoxGoneMessage("MCP error -32001")).toBe(false)
    expect(isBoxGoneMessage(undefined)).toBe(false)
  })

  it("reads the evidence off lastError / lastTurnErrorMessage", () => {
    expect(
      hasSandboxGoneEvidence({
        ...base,
        endedReason: undefined,
        lastTurnErrorMessage: "Sandbox is probably not running anymore",
      }),
    ).toBe(true)
    expect(
      hasSandboxGoneEvidence({ ...base, endedReason: "crashed", lastError: "[crashed] pid 4242 gone" }),
    ).toBe(false)
  })

  it("consults the ledger's gone state, then ONE provider probe — alive means not gone", async () => {
    const desc = { ...base, endedReason: "crashed" as const }
    // Ledger says gone — no probe needed.
    await expect(
      isSandboxBoxGone(desc as never, {
        readLedger: () => [{ sandboxId: "sbx_1", state: "gone" } as never],
      }),
    ).resolves.toBe(true)
    // Ledger silent → provider probe: alive ⇒ false.
    const probe = vi.fn(async () => ({ alive: true }))
    await expect(
      isSandboxBoxGone(desc as never, {
        readLedger: () => [],
        resolveSandboxProvider: async () =>
          ({
            provider: { boot: async () => ({ mcpUrl: "", sandboxId: "sbx_1", async stop() {} }), probe },
            slug: "e2b",
            name: "e2b",
            version: "test",
            description: "test",
            requiresSetup: false,
            capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
            async check() {
              return true
            },
          }) as never,
      }),
    ).resolves.toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
    // Probe says the id is gone ⇒ true.
    await expect(
      isSandboxBoxGone(desc as never, {
        readLedger: () => [],
        resolveSandboxProvider: async () =>
          ({
            provider: {
              boot: async () => ({ mcpUrl: "", sandboxId: "sbx_1", async stop() {} }),
              probe: async () => ({ alive: false }),
            },
            slug: "e2b",
            name: "e2b",
            version: "test",
            description: "test",
            requiresSetup: false,
            capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
            async check() {
              return true
            },
          }) as never,
      }),
    ).resolves.toBe(true)
  })

  it("a throwing probe is 'unknown', never death", async () => {
    const desc = { ...base, endedReason: "crashed" as const }
    await expect(
      isSandboxBoxGone(desc as never, {
        readLedger: () => [],
        resolveSandboxProvider: async () =>
          ({
            provider: {
              boot: async () => ({ mcpUrl: "", sandboxId: "sbx_1", async stop() {} }),
              probe: async () => {
                throw new Error("provider unreachable")
              },
            },
            slug: "e2b",
            name: "e2b",
            version: "test",
            description: "test",
            requiresSetup: false,
            capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
            async check() {
              return true
            },
          }) as never,
      }),
    ).resolves.toBe(false)
  })

  it("a non-box session is never 'box gone'", async () => {
    await expect(
      isSandboxBoxGone({ ...base, sandboxId: undefined, remote: false, endedReason: "sandbox_gone" } as never),
    ).resolves.toBe(false)
  })
})

// ── `daemon.sandboxGoneRestartDefault` — the opt-in default ─────────────────

describe("boxRestartPolicyDefault (daemon.sandboxGoneRestartDefault)", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sandbox-gone-default-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function registryWith(boxRestartPolicyDefault?: RestartPolicy): SessionsRegistry {
    return createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      ...(boxRestartPolicyDefault ? { boxRestartPolicyDefault } : {}),
    })
  }

  const BOX_SPAWN = {
    workspaceSlug: "default",
    cwd: "/home/user",
    adapterSlug: "fake-cli",
    remote: true,
    sandboxId: "sbx_defaulted",
  } as const

  it("opt-in stamps the sandbox-gone policy on a BOX spawn with no explicit policy", () => {
    const reg = registryWith(SANDBOX_GONE_DEFAULT_RESTART_POLICY)
    try {
      const desc = reg.spawnAgent({
        ...BOX_SPAWN,
        agentSession: liveAgentSession("box-default"),
      })
      expect(desc.restartPolicy).toEqual(SANDBOX_GONE_DEFAULT_RESTART_POLICY)
      expect(desc.restartPolicy!.on).toEqual(["sandbox-gone"])
    } finally {
      reg.shutdown()
    }
  })

  it("OFF (no registry opt) leaves the same box spawn policy-less, exactly as before", () => {
    const reg = registryWith()
    try {
      const desc = reg.spawnAgent({
        ...BOX_SPAWN,
        agentSession: liveAgentSession("box-no-default"),
      })
      expect(desc.restartPolicy).toBeUndefined()
    } finally {
      reg.shutdown()
    }
  })

  it("the opt-in never leaks onto a NON-box spawn", () => {
    const reg = registryWith(SANDBOX_GONE_DEFAULT_RESTART_POLICY)
    try {
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        adapterSlug: "fake-cli",
        agentSession: liveAgentSession("local-default"),
      })
      expect(desc.restartPolicy).toBeUndefined()
    } finally {
      reg.shutdown()
    }
  })

  it("an explicit per-session restartPolicy always wins", () => {
    const reg = registryWith(SANDBOX_GONE_DEFAULT_RESTART_POLICY)
    try {
      const explicit: RestartPolicy = { ...SANDBOX_GONE_DEFAULT_RESTART_POLICY, on: ["crashed"] }
      const desc = reg.spawnAgent({
        ...BOX_SPAWN,
        agentSession: liveAgentSession("box-explicit"),
        restartPolicy: explicit,
      })
      expect(desc.restartPolicy).toEqual(explicit)
    } finally {
      reg.shutdown()
    }
  })
})
