import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSessionsRegistry,
  MAX_RESUME_ATTEMPTS,
  type AgentSessionLike,
  type AgentSessionResumer,
  type SessionDescriptor,
} from "../sessions.js"
import {
  continueInterruptedSessions,
  continueSkipReason,
  runContinueOnBootPass,
  DEFAULT_CONTINUE_PROMPT,
  MAX_AUTO_CONTINUE_ATTEMPTS,
} from "../continue-interrupted.js"
import { runEagerResumePass } from "../eager-resume.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { compactSessionItem, registerSessionTools } from "../session-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createCompletionPolicySupervisor } from "../supervisor.js"

/**
 * Continue-interrupted (manual verb + opt-in continue-on-boot pass).
 *
 * "Simulate a restart" = seed a persisted snapshot (or shut a registry down)
 * and construct a fresh registry; its boot reload reclassifies running rows to
 * killed/daemon-restart exactly as a real restart would, deriving
 * `killedMidTurn` from `busy` and stamping `interruptedAtBoot`.
 */

type Row = Partial<SessionDescriptor> & { id: string }

function writeSessions(persistPath: string, rows: Row[]): void {
  writeFileSync(
    persistPath,
    JSON.stringify({
      savedAt: "2026-09-27T00:00:00Z",
      sessions: rows.map(r => ({
        kind: "agent-cli",
        workspaceSlug: "default",
        command: "claude (agent)",
        pid: null,
        status: "running",
        startedAt: "2026-09-27T00:00:00Z",
        busy: false,
        adapterSlug: "claude-code",
        adapterSessionId: `acp-${r.id}`,
        cwd: "/tmp",
        ...r,
      })),
    }),
  )
}

/** Resumer whose sessions record every event into `log` (`resume:<id>` /
 *  `send:<id>:<message>`). `hang` ids get a turn that never ends (so a
 *  following shutdown catches them mid-turn); `refuse` ids fail to resume. */
function makeResumer(
  log: string[],
  opts: { hang?: readonly string[]; refuse?: readonly string[] } = {},
): AgentSessionResumer {
  return vi.fn(async (input: { descriptor: SessionDescriptor }) => {
    const id = input.descriptor.id
    log.push(`resume:${id}`)
    if (opts.refuse?.includes(id)) return null
    const session: AgentSessionLike = {
      sessionId: input.descriptor.adapterSessionId ?? "acp-fresh",
      async *send(message: unknown) {
        log.push(`send:${id}:${promptText(message)}`)
        if (opts.hang?.includes(id)) await new Promise<never>(() => {})
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    return session
  })
}

/** The adapter receives the prompt as a text content block (or blocks). */
function promptText(message: unknown): string {
  const blocks = Array.isArray(message) ? message : [message]
  return blocks
    .map(b => (typeof b === "string" ? b : (b as { text?: string }).text ?? ""))
    .join("")
}

const settle = (ms = 30): Promise<void> => new Promise(res => setTimeout(res, ms))
const sends = (log: string[]): string[] => log.filter(l => l.startsWith("send:"))

describe("continueSkipReason (eligibility)", () => {
  const boot = "boot_now"
  const base: SessionDescriptor = {
    id: "s",
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude (agent)",
    pid: null,
    status: "killed",
    startedAt: "2026-09-27T00:00:00Z",
    adapterSlug: "claude-code",
    adapterSessionId: "acp-s",
    cwd: "/tmp",
    killedMidTurn: true,
    endedReason: "daemon-restart",
    interruptedAtBoot: boot,
  }

  it("an interrupted, resumable, idle row from the last restart is eligible in both modes", () => {
    expect(continueSkipReason(base, boot, "manual")).toBeUndefined()
    expect(continueSkipReason(base, boot, "boot")).toBeUndefined()
  })

  it("skips rows that aren't interrupted, were interrupted by an older restart, aren't resumable, are capped, or busy", () => {
    expect(continueSkipReason({ ...base, killedMidTurn: false }, boot, "manual")).toBe("not-interrupted")
    expect(continueSkipReason({ ...base, endedReason: "operator-stopped" }, boot, "manual")).toBe("not-interrupted")
    expect(continueSkipReason({ ...base, interruptedAtBoot: "boot_old" }, boot, "manual")).toBe("stale-interrupt")
    expect(continueSkipReason({ ...base, interruptedAtBoot: undefined }, boot, "manual")).toBe("stale-interrupt")
    expect(continueSkipReason({ ...base, kind: "terminal", pty: true }, boot, "manual")).toBe("not-resumable")
    expect(continueSkipReason({ ...base, archived: true }, boot, "manual")).toBe("retired")
    expect(continueSkipReason({ ...base, continuedTo: "s2" }, boot, "boot")).toBe("retired")
    expect(continueSkipReason({ ...base, retiredAt: "2026-09-27T00:00:00Z" }, boot, "manual")).toBe("retired")
    expect(
      continueSkipReason({ ...base, resumeAttempts: MAX_RESUME_ATTEMPTS }, boot, "manual"),
    ).toBe("resume-cap-exhausted")
    expect(continueSkipReason({ ...base, busy: true }, boot, "manual")).toBe("busy")
  })

  it("boot mode adds the no-loop gates; a human (manual) is not bound by them", () => {
    const failed = { ...base, resumeAttempts: 1 }
    const again = { ...base, lastAutoContinueBoot: boot, autoContinueAttempts: 1 }
    const capped = { ...base, autoContinueAttempts: MAX_AUTO_CONTINUE_ATTEMPTS }
    expect(continueSkipReason(failed, boot, "boot")).toBe("resume-failed")
    expect(continueSkipReason(again, boot, "boot")).toBe("already-auto-continued")
    expect(continueSkipReason(capped, boot, "boot")).toBe("auto-continue-cap")
    expect(continueSkipReason(failed, boot, "manual")).toBeUndefined()
    expect(continueSkipReason(again, boot, "manual")).toBeUndefined()
    expect(continueSkipReason(capped, boot, "manual")).toBeUndefined()
  })
})

describe("continueInterruptedSessions against a rehydrated registry", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "continue-interrupted-"))
    persistPath = join(tmp, "sessions.json")
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function seedMixed(): void {
    writeSessions(persistPath, [
      // Cut off mid-turn by THIS restart → eligible.
      { id: "mid", busy: true, lastActivityAt: "2026-09-27T01:00:00Z" },
      { id: "mid2", busy: true, name: "worker", lastActivityAt: "2026-09-27T02:00:00Z" },
      // Idle at the restart → not interrupted, not listed.
      { id: "idle", busy: false },
      // Interrupted by an EARLIER restart, never picked up → stale.
      {
        id: "old",
        status: "killed",
        killedMidTurn: true,
        endedReason: "daemon-restart",
        interruptedAtBoot: "boot_older",
      },
      // Interrupted but a PTY → not resumable.
      { id: "pty", kind: "terminal", pty: true, busy: true },
    ])
  }

  it("stamps interruptedAtBoot with this boot on rows the restart cut off", () => {
    seedMixed()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer([]) })
    expect(reg.get("mid")?.interrupted).toBe(true)
    expect(reg.get("mid")?.interruptedAtBoot).toBe(reg.bootId)
    expect(reg.get("idle")?.interruptedAtBoot).toBeUndefined()
    expect(reg.get("old")?.interruptedAtBoot).toBe("boot_older")
    reg.shutdown()
  })

  it("dry run (the default) lists eligible rows newest-activity-first + skips, and sends nothing", async () => {
    seedMixed()
    const log: string[] = []
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log) })

    const res = await continueInterruptedSessions({ registry: reg, mode: "manual" })

    expect(res.dryRun).toBe(true)
    expect(res.prompt).toBe(DEFAULT_CONTINUE_PROMPT)
    expect(res.sessions).toEqual([
      { id: "mid2", name: "worker", status: "eligible" },
      { id: "mid", status: "eligible" },
      { id: "old", status: "skipped", reason: "stale-interrupt" },
      { id: "pty", status: "skipped", reason: "not-resumable" },
    ])
    expect(res.eligible).toBe(2)
    expect(log).toEqual([])
    expect(reg.get("mid")?.status).toBe("killed")
    reg.shutdown()
  })

  it("dryRun:false sends the prompt through the normal path — lazy resume first — and the turn-end clears the markers", async () => {
    seedMixed()
    const log: string[] = []
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log) })

    const res = await continueInterruptedSessions({ registry: reg, mode: "manual", dryRun: false })
    await settle()

    expect(res.sent).toBe(2)
    expect(res.sessions.filter(s => s.status === "sent").map(s => s.id)).toEqual(["mid2", "mid"])
    expect(log).toContain("resume:mid")
    expect(sends(log)).toEqual([
      `send:mid2:${DEFAULT_CONTINUE_PROMPT}`,
      `send:mid:${DEFAULT_CONTINUE_PROMPT}`,
    ])
    expect(reg.get("mid")?.status).toBe("running")
    expect(reg.get("mid")?.interrupted).toBeUndefined()
    expect(reg.get("mid")?.interruptedAtBoot).toBeUndefined()
    // Nothing else was touched.
    expect(log.some(l => l.includes(":old") || l.includes(":idle"))).toBe(false)
    reg.shutdown()
  })

  it("honours the ids filter (id or unknown) and a custom prompt", async () => {
    seedMixed()
    const log: string[] = []
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log) })

    const res = await continueInterruptedSessions({
      registry: reg,
      mode: "manual",
      dryRun: false,
      ids: ["mid", "idle", "nope"],
      prompt: "carry on",
    })
    await settle()

    expect(res.sessions).toEqual([
      { id: "mid", status: "sent" },
      { id: "idle", status: "skipped", reason: "not-interrupted" },
      { id: "nope", status: "skipped", reason: "unknown" },
    ])
    expect(sends(log)).toEqual(["send:mid:carry on"])
    reg.shutdown()
  })

  it("skips a busy row and a resume-capped row without calling the adapter", async () => {
    writeSessions(persistPath, [
      { id: "capped", busy: true, resumeAttempts: MAX_RESUME_ATTEMPTS },
    ])
    const log: string[] = []
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log) })
    const res = await continueInterruptedSessions({ registry: reg, mode: "manual", dryRun: false })
    expect(res.sessions).toEqual([{ id: "capped", status: "skipped", reason: "resume-cap-exhausted" }])
    expect(log).toEqual([])
    reg.shutdown()
  })

  it("reports a send that fails admission as failed and carries on", async () => {
    writeSessions(persistPath, [
      { id: "refused", busy: true, lastActivityAt: "2026-09-27T02:00:00Z" },
      { id: "ok", busy: true, lastActivityAt: "2026-09-27T01:00:00Z" },
    ])
    const log: string[] = []
    const reg = createSessionsRegistry({
      persistPath,
      resumeAgent: makeResumer(log, { refuse: ["refused"] }),
    })
    const res = await continueInterruptedSessions({ registry: reg, mode: "manual", dryRun: false })
    await settle()
    expect(res.sessions.map(s => [s.id, s.status])).toEqual([
      ["refused", "failed"],
      ["ok", "sent"],
    ])
    expect(res.failed).toBe(1)
    reg.shutdown()
  })

  // Live repro (build 7e38e0aa): three rows failed with a bare
  // `enqueuePrompt: session "…" is not alive (status=killed)` — the lazy resume
  // DID run (resumeAttempts went 0 → 1) but the adapter respawn failed, and the
  // outcome hid that behind the post-resume admission error.
  it("a send whose in-place resume fails says so, not just 'not alive'", async () => {
    writeSessions(persistPath, [{ id: "refused", busy: true }])
    const reg = createSessionsRegistry({
      persistPath,
      resumeAgent: makeResumer([], { refuse: ["refused"] }),
    })
    const res = await continueInterruptedSessions({ registry: reg, mode: "manual", dryRun: false })
    const [out] = res.sessions
    expect(out?.status).toBe("failed")
    expect(out?.status === "failed" ? out.error : "").toMatch(/in-place resume failed/)
    expect(reg.get("refused")?.resumeAttempts).toBe(1)
    reg.shutdown()
  })

  // Live repro: the three failed rows' worktrees had been removed, so the
  // respawn hit `cwd '…' does not exist`. That is knowable up front — the dry
  // run must not call such a row eligible, and the send must not burn a
  // resume attempt on it.
  it("a row whose cwd no longer exists is skipped (cwd-missing) in dry run and send alike", async () => {
    writeSessions(persistPath, [
      { id: "gone", busy: true, cwd: join(tmp, "removed-worktree") },
      { id: "here", busy: true, cwd: tmp },
    ])
    const log: string[] = []
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log) })

    const dry = await continueInterruptedSessions({ registry: reg, mode: "manual" })
    expect(dry.sessions).toEqual([
      { id: "here", status: "eligible" },
      { id: "gone", status: "skipped", reason: "cwd-missing" },
    ])

    const sent = await continueInterruptedSessions({ registry: reg, mode: "manual", dryRun: false })
    await settle()
    expect(sent.sessions.map(s => [s.id, s.status])).toEqual([
      ["here", "sent"],
      ["gone", "skipped"],
    ])
    expect(log).not.toContain("resume:gone")
    expect(reg.get("gone")?.resumeAttempts).toBeUndefined()
    reg.shutdown()
  })

  it("session_list's compact projection carries interrupted:true (and omits it otherwise)", () => {
    seedMixed()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer([]) })
    expect(compactSessionItem(reg.get("mid")!).interrupted).toBe(true)
    expect("interrupted" in compactSessionItem(reg.get("idle")!)).toBe(false)
    reg.shutdown()
  })
})

describe("continue-on-boot: no-loop rules", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "continue-noloop-"))
    persistPath = join(tmp, "sessions.json")
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("at most one auto-continue per restart: a second pass in the same boot sends nothing", async () => {
    writeSessions(persistPath, [{ id: "s", busy: true }])
    const log: string[] = []
    // Hang the continue turn so the row stays interrupted between passes.
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log, { hang: ["s"] }) })

    const first = await runContinueOnBootPass({ registry: reg, concurrency: 4 })
    expect(first).toMatchObject({ enabled: true, eligible: 1, sent: 1 })
    expect(reg.get("s")?.autoContinueAttempts).toBe(1)
    expect(reg.get("s")?.lastAutoContinueBoot).toBe(reg.bootId)

    const second = await runContinueOnBootPass({ registry: reg, concurrency: 4 })
    expect(second.sent).toBe(0)
    expect(sends(log)).toHaveLength(1)
    reg.shutdown()
  })

  it("a row re-interrupted by each restart gets one auto-continue per restart, then stops at the cap", async () => {
    writeSessions(persistPath, [{ id: "s", busy: true }])
    const log: string[] = []
    const resumer = makeResumer(log, { hang: ["s"] })

    // Each boot: rehydrate, auto-continue (turn hangs mid-flight), then the
    // daemon goes down again with the continue turn still running.
    const summaries = []
    let manualSent = -1
    for (let boot = 0; boot < MAX_AUTO_CONTINUE_ATTEMPTS + 2; boot++) {
      const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
      expect(reg.get("s")?.interrupted).toBe(true)
      // Every restart caught a continue turn mid-flight, so each boot
      // re-stamps the row as interrupted by ITS restart.
      expect(reg.get("s")?.interruptedAtBoot).toBe(reg.bootId)
      summaries.push(await runContinueOnBootPass({ registry: reg, concurrency: 4 }))
      if (boot === MAX_AUTO_CONTINUE_ATTEMPTS) {
        // The cap binds the automatic pass only — a human can still send one
        // (which the next restart cuts off mid-turn again).
        const manual = await continueInterruptedSessions({ registry: reg, mode: "manual", dryRun: false })
        manualSent = manual.sent
      }
      await settle(10)
      reg.shutdown()
    }

    expect(summaries.map(s => s.sent)).toEqual([
      ...Array.from({ length: MAX_AUTO_CONTINUE_ATTEMPTS }, () => 1),
      0,
      0,
    ])
    expect(manualSent).toBe(1)
    // Without that manual send the capped row would stay dead, so the next
    // restart would NOT re-interrupt it: it becomes a stale interruption that
    // not even the manual verb picks up (covered by the stale-row tests).
    // MAX automatic sends + the one manual send; the post-manual boot (row
    // interrupted again, still over the cap) sends nothing.
    expect(sends(log)).toHaveLength(MAX_AUTO_CONTINUE_ATTEMPTS + 1)
  })

  it("a successful continue turn resets the budget", async () => {
    writeSessions(persistPath, [{ id: "s", busy: true }])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer([]) })
    await runContinueOnBootPass({ registry: reg, concurrency: 4 })
    await settle()
    const d = reg.get("s")!
    expect(d.interrupted).toBeUndefined()
    expect(d.autoContinueAttempts).toBeUndefined()
    expect(d.lastAutoContinueBoot).toBeUndefined()
    reg.shutdown()
  })

  it("never auto-continues a row whose eager resume failed (and never retries the resume)", async () => {
    writeSessions(persistPath, [
      { id: "broken", busy: true },
      { id: "fine", busy: true },
    ])
    const log: string[] = []
    const reg = createSessionsRegistry({
      persistPath,
      resumeAgent: makeResumer(log, { refuse: ["broken"] }),
    })

    const eager = await runEagerResumePass({ registry: reg, concurrency: 4 })
    expect(eager).toMatchObject({ resumed: 1, failed: 1 })
    const cont = await runContinueOnBootPass({ registry: reg, concurrency: 4 })
    await settle()

    expect(cont.sent).toBe(1)
    expect(sends(log).map(l => l.split(":")[1])).toEqual(["fine"])
    expect(log.filter(l => l === "resume:broken")).toHaveLength(1)
    expect(reg.get("broken")?.autoContinueAttempts).toBeUndefined()
    reg.shutdown()
  })

  it("leaves a stale interruption (older restart) alone", async () => {
    writeSessions(persistPath, [
      {
        id: "old",
        status: "killed",
        killedMidTurn: true,
        endedReason: "daemon-restart",
        interruptedAtBoot: "boot_older",
      },
    ])
    const log: string[] = []
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log) })
    const cont = await runContinueOnBootPass({ registry: reg, concurrency: 4 })
    expect(cont).toMatchObject({ eligible: 0, sent: 0, skipped: 1 })
    expect(log).toEqual([])
    reg.shutdown()
  })

  // Live repro (sess_c6a0f2d1 & co.): rows cut off by a restart the day
  // before, persisted terminal by a daemon predating `interruptedAtBoot`, were
  // stamped with the CURRENT boot on the first boot that read them — and so
  // reported eligible, and auto-continued by the boot pass.
  it("an interrupted row with no boot marker on disk (older restart / pre-feature) is stale, not this boot's", async () => {
    writeSessions(persistPath, [
      {
        id: "legacy",
        status: "killed",
        killedMidTurn: true,
        endedReason: "daemon-restart",
        endedAt: "2026-09-26T23:56:39.628Z",
      },
    ])
    const log: string[] = []
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log) })
    expect(reg.get("legacy")?.interrupted).toBe(true)
    expect(reg.get("legacy")?.interruptedAtBoot).not.toBe(reg.bootId)

    const dry = await continueInterruptedSessions({ registry: reg, mode: "manual" })
    expect(dry.sessions).toEqual([{ id: "legacy", status: "skipped", reason: "stale-interrupt" }])
    const boot = await runContinueOnBootPass({ registry: reg, concurrency: 4 })
    expect(boot).toMatchObject({ eligible: 0, sent: 0, skipped: 1 })
    expect(log).toEqual([])
    reg.shutdown()

    // ...and it stays stale on every later boot too.
    const next = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log) })
    expect(continueSkipReason(next.get("legacy")!, next.bootId, "manual")).toBe("stale-interrupt")
    next.shutdown()
  })

  it("a row the graceful shutdown cut off mid-turn IS the next boot's (only that boot's)", async () => {
    writeSessions(persistPath, [{ id: "s", busy: false }])
    const log: string[] = []
    const resumer = makeResumer(log, { hang: ["s"] })
    const first = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    // Put a turn in flight, then shut down gracefully under it.
    await first.enqueuePrompt("s", "work")
    await settle(10)
    first.shutdown()

    const second = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    expect(second.get("s")?.interruptedAtBoot).toBe(second.bootId)
    const dry = await continueInterruptedSessions({ registry: second, mode: "manual" })
    expect(dry.sessions).toEqual([{ id: "s", status: "eligible" }])
    // Nobody picks it up; the NEXT boot must see it as stale.
    second.shutdown()
    const third = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    expect(continueSkipReason(third.get("s")!, third.bootId, "manual")).toBe("stale-interrupt")
    third.shutdown()
  })

  it("bounds concurrency and respects the cross-process isServed gate", async () => {
    writeSessions(persistPath, [
      { id: "a", busy: true },
      { id: "b", busy: true },
      { id: "c", busy: true },
      { id: "foreign", busy: true, workspaceSlug: "other" },
    ])
    let active = 0
    let peak = 0
    const resumer: AgentSessionResumer = vi.fn(async (input: { descriptor: SessionDescriptor }) => {
      active++
      peak = Math.max(peak, active)
      await settle(25)
      active--
      const s: AgentSessionLike = {
        sessionId: input.descriptor.adapterSessionId ?? "acp",
        async *send() {
          yield { kind: "turn-end", reason: "completed" }
        },
        async cancel() {},
        async close() {},
      }
      return s
    })
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    const cont = await runContinueOnBootPass({
      registry: reg,
      concurrency: 2,
      isServed: d => d.workspaceSlug === "default",
    })
    await settle()
    expect(cont.sent).toBe(3)
    expect(peak).toBeLessThanOrEqual(2)
    expect(reg.get("foreign")?.status).toBe("killed")
    reg.shutdown()
  })
})

describe("continue-on-boot ordering: after the eager pass and the supervisor re-arm", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "continue-order-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("a re-armed lone-session policy sees the continue turn's turn-end and completes", async () => {
    const id = "sess_watched"
    const sessionsPath = join(tmp, "sessions.json")
    const policiesPath = join(tmp, "policies.json")
    mkdirSync(join(tmp, ".agentproto"), { recursive: true })
    writeFileSync(
      join(tmp, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["true"] }),
    )
    writeSessions(sessionsPath, [{ id, busy: true, cwd: tmp }])
    writeFileSync(
      policiesPath,
      JSON.stringify({
        policies: [
          {
            input: { sessionId: id, gate: { command: "true" }, then: "emit" },
            state: {
              policyId: "pol_watched",
              sessionId: id,
              sessionIds: [id],
              pending: [id],
              status: "watching",
              startedAt: "2026-09-27T00:00:00Z",
              retries: 0,
            },
          },
        ],
      }),
    )

    const log: string[] = []
    const bus = createSessionEventBus()
    // Real boot order: registry (reclassify) → supervisor re-arm → eager pass
    // → continue pass.
    const reg = createSessionsRegistry({
      persistPath: sessionsPath,
      sessionEvents: bus,
      resumeAgent: makeResumer(log),
    })
    const supervisor = createCompletionPolicySupervisor({
      registry: reg,
      sessionEvents: bus,
      workspace: tmp,
      persistPath: policiesPath,
    })
    const passed = new Promise<string>(resolve => {
      bus.on("policy:passed", ev => resolve(ev.policyId))
    })

    await runEagerResumePass({ registry: reg, concurrency: 4 })
    // Eager resume alone runs no turn: the row is live but still interrupted,
    // and the policy is still waiting.
    expect(reg.get(id)?.status).toBe("running")
    expect(reg.get(id)?.interrupted).toBe(true)
    expect(supervisor.getStatus("pol_watched")?.status).toBe("watching")

    const cont = await runContinueOnBootPass({ registry: reg, concurrency: 4 })
    expect(cont.sent).toBe(1)
    // Resumed by the eager pass, not by the continue send.
    expect(log).toEqual([`resume:${id}`, `send:${id}:${DEFAULT_CONTINUE_PROMPT}`])

    await expect(passed).resolves.toBe("pol_watched")
    await settle(20)
    expect(supervisor.getStatus("pol_watched")?.status).toBe("done")
    expect(reg.get(id)?.interrupted).toBeUndefined()
    reg.shutdown()
  })
})

describe("session_continue_interrupted MCP tool + session_list surface", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "continue-mcp-"))
    persistPath = join(tmp, "sessions.json")
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  async function harness(log: string[]): Promise<{
    client: Client
    reg: ReturnType<typeof createSessionsRegistry>
    close: () => Promise<void>
  }> {
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer(log) })
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, { registry: reg, workspace: tmp })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)
    return { client, reg, close: () => client.close() }
  }

  const json = (result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> =>
    JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}")

  it("defaults to a dry run; dryRun:false (string form too) sends; ids accept names", async () => {
    writeSessions(persistPath, [
      { id: "a", name: "alpha", busy: true },
      { id: "b", busy: true },
    ])
    const log: string[] = []
    const { client, reg, close } = await harness(log)

    const dry = json(await client.callTool({ name: "session_continue_interrupted", arguments: {} }))
    expect(dry.dryRun).toBe(true)
    expect(dry.eligible).toBe(2)
    expect(log).toEqual([])

    const wet = json(
      await client.callTool({
        name: "session_continue_interrupted",
        arguments: { dryRun: "false", ids: ["alpha"], prompt: "go on" },
      }),
    )
    await settle()
    expect(wet.sessions).toEqual([{ id: "a", name: "alpha", status: "sent" }])
    expect(sends(log)).toEqual(["send:a:go on"])
    expect(reg.get("b")?.status).toBe("killed")

    await close()
    reg.shutdown()
  })

  it("session_list's default compact rows flag interrupted sessions", async () => {
    writeSessions(persistPath, [{ id: "cut", busy: true }, { id: "fine", busy: false }])
    const { client, reg, close } = await harness([])
    const res = json(await client.callTool({ name: "session_list", arguments: {} }))
    const rows = res.sessions as Array<{ id: string; interrupted?: boolean }>
    expect(rows.find(r => r.id === "cut")?.interrupted).toBe(true)
    expect(rows.find(r => r.id === "fine")?.interrupted).toBeUndefined()
    await close()
    reg.shutdown()
  })
})
