import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSessionsRegistry,
  MAX_RESUME_ATTEMPTS,
  type AgentSessionLike,
  type SessionDescriptor,
} from "../sessions.js"
import { runEagerResumePass } from "../eager-resume.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createCompletionPolicySupervisor } from "../supervisor.js"

/**
 * Opt-in eager resume-on-boot (session-survivability plan §5, PR-4).
 *
 * A daemon restart leaves every previously-running agent-cli row reclassified
 * to `killed`/`endedReason:"daemon-restart"`. Lazy resume-on-prompt revives one
 * on its next prompt; the eager pass (this PR) revives the eligible ones at boot
 * WITHOUT a prompt, so orchestrated fleets come back live. It reuses the exact
 * lazy `maybeResumeAgent` code path (so #634 auth re-resolution, #635
 * `session:resumed`/banner, and #636 attempt cap apply for free), adds two
 * eager-only pre-flights (cwd-exists, worktree-generation), and NEVER
 * fresh-spawns an id the adapter rejects.
 *
 * "Simulate a restart" = seed a persisted snapshot and construct a fresh
 * registry; its boot reload reclassifies the running rows exactly as a real
 * daemon restart would.
 */

/** A minimal persisted row. `status:"running"` + `busy` is the daemon-restart
 *  shape (the boot reload reclassifies it to killed/daemon-restart, deriving
 *  `killedMidTurn` from `busy`); pass an explicit terminal `status` for the
 *  never-eager-resumed cases. */
type Row = Partial<SessionDescriptor> & { id: string }

function writeSessions(persistPath: string, rows: Row[]): void {
  writeFileSync(
    persistPath,
    JSON.stringify({
      savedAt: "2026-07-23T00:00:00Z",
      sessions: rows.map(r => ({
        kind: "agent-cli",
        workspaceSlug: "default",
        command: "claude (agent)",
        pid: null,
        status: "running",
        startedAt: "2026-07-23T00:00:00Z",
        busy: false,
        adapterSlug: "claude-code",
        adapterSessionId: `acp-${r.id}`,
        cwd: "/tmp",
        ...r,
      })),
    }),
  )
}

/** A resumer that returns a fresh live session and records, in call order, the
 *  descriptor id it was asked to resume (for ordering assertions). */
function makeRecordingResumer(calls: string[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: { descriptor: SessionDescriptor }) => {
    calls.push(input.descriptor.id)
    const fresh: AgentSessionLike = {
      sessionId: input.descriptor.adapterSessionId ?? "acp-fresh",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    return fresh
  })
}

/** A resumer that tracks peak concurrency: each call holds a slot for ~25ms so
 *  the pool's cap is observable. */
function makeConcurrencyResumer(): {
  resumer: ReturnType<typeof vi.fn>
  maxConcurrent: () => number
} {
  let active = 0
  let peak = 0
  const resumer = vi.fn(async (input: { descriptor: SessionDescriptor }) => {
    active++
    peak = Math.max(peak, active)
    await new Promise(res => setTimeout(res, 25))
    active--
    const fresh: AgentSessionLike = {
      sessionId: input.descriptor.adapterSessionId ?? "acp-fresh",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    return fresh
  })
  return { resumer, maxConcurrent: () => peak }
}

describe("registry.resumeOnBoot (per-row eager resume)", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "eager-resume-"))
    persistPath = join(tmp, "sessions.json")
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("resumes an idle daemon-restart ghost in place with NO prompt, emitting session:resumed{interrupted:false}", async () => {
    writeSessions(persistPath, [{ id: "idle", busy: false }])
    const bus = createSessionEventBus()
    const resumed = vi.fn()
    bus.on("session:resumed", resumed)
    const calls: string[] = []
    const resumer = makeRecordingResumer(calls)
    const reg = createSessionsRegistry({ persistPath, sessionEvents: bus, resumeAgent: resumer })

    expect(reg.get("idle")?.status).toBe("killed")

    const outcome = await reg.resumeOnBoot("idle")

    expect(outcome).toEqual({ status: "resumed" })
    expect(reg.get("idle")?.status).toBe("running")
    expect(resumer).toHaveBeenCalledTimes(1)
    expect(resumed).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:resumed", sessionId: "idle", interrupted: false }),
    )
    reg.shutdown()
  })

  it("resumes a killedMidTurn ghost, emitting session:resumed{interrupted:true} + the interrupted banner (markers persist until next turn-end)", async () => {
    writeSessions(persistPath, [{ id: "midturn", busy: true }])
    const bus = createSessionEventBus()
    const resumed = vi.fn()
    bus.on("session:resumed", resumed)
    const reg = createSessionsRegistry({ persistPath, sessionEvents: bus, resumeAgent: makeRecordingResumer([]) })
    const records: Array<Record<string, unknown>> = []
    reg.subscribeToRecords("midturn", rec => records.push(rec))

    expect(reg.get("midturn")?.interrupted).toBe(true)
    const outcome = await reg.resumeOnBoot("midturn")

    expect(outcome).toEqual({ status: "resumed" })
    expect(reg.get("midturn")?.status).toBe("running")
    // Eager resume runs no turn, so the interrupted markers stay set — a caller
    // must re-issue; the next successful turn-end clears them (§4).
    expect(reg.get("midturn")?.interrupted).toBe(true)
    expect(resumed).toHaveBeenCalledWith(
      expect.objectContaining({ interrupted: true, resumedFrom: "daemon-restart" }),
    )
    const notice = records.find(r => r.kind === "notice")
    expect(String(notice?.text)).toContain("interrupted and was NOT re-run")

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("skips a user-killed row (no daemon-restart reason) without touching the adapter", async () => {
    writeSessions(persistPath, [{ id: "userkill", status: "killed" }])
    const resumer = makeRecordingResumer([])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    const outcome = await reg.resumeOnBoot("userkill")
    expect(outcome).toEqual({ status: "skipped", reason: "not-daemon-restart" })
    expect(resumer).not.toHaveBeenCalled()
    expect(reg.get("userkill")?.status).toBe("killed")
    reg.shutdown()
  })

  it("skips a naturally-exited row without touching the adapter", async () => {
    writeSessions(persistPath, [{ id: "done", status: "exited", exitCode: 0 }])
    const resumer = makeRecordingResumer([])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    expect(await reg.resumeOnBoot("done")).toEqual({ status: "skipped", reason: "not-daemon-restart" })
    expect(resumer).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("skips a PTY ghost (not-resumable) even though it carries the daemon-restart reason", async () => {
    writeSessions(persistPath, [{ id: "pty", kind: "terminal", pty: true }])
    const resumer = makeRecordingResumer([])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    // Reclassified to killed/daemon-restart at boot, but PTY is never in-place resumable.
    expect(reg.get("pty")?.endedReason).toBe("daemon-restart")
    expect(await reg.resumeOnBoot("pty")).toEqual({ status: "skipped", reason: "not-resumable" })
    expect(resumer).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("skips an archived row (not-resumable)", async () => {
    writeSessions(persistPath, [{ id: "arch", archived: true }])
    const resumer = makeRecordingResumer([])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    expect(await reg.resumeOnBoot("arch")).toEqual({ status: "skipped", reason: "not-resumable" })
    expect(resumer).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("skips a cap-exhausted row without spawning (persisted attempt cap)", async () => {
    writeSessions(persistPath, [{ id: "capped", resumeAttempts: MAX_RESUME_ATTEMPTS }])
    const resumer = makeRecordingResumer([])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    expect(await reg.resumeOnBoot("capped")).toEqual({ status: "skipped", reason: "cap-exhausted" })
    expect(resumer).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("fails clean when cwd is gone — counts an attempt, no spawn", async () => {
    const missing = join(tmp, "gone-worktree")
    writeSessions(persistPath, [{ id: "cwdgone", cwd: missing }])
    const resumer = makeRecordingResumer([])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    const outcome = await reg.resumeOnBoot("cwdgone")
    expect(outcome).toEqual({ status: "failed", reason: "cwd-missing" })
    expect(resumer).not.toHaveBeenCalled()
    expect(reg.get("cwdgone")?.status).toBe("killed")
    // Same debt a spawn into a missing dir would incur — so a permanently-gone
    // worktree can't be retried every boot forever.
    expect(reg.get("cwdgone")?.resumeAttempts).toBe(1)
    reg.shutdown()
  })

  it("skips a worktree-generation mismatch (worktreeId pinned but the path no longer carries that marker) — no spawn, no attempt", async () => {
    // cwd exists (the tmp dir) but is a plain dir with no worktree provision
    // marker, so resolveWorktreeIdentity returns no worktreeId — a mismatch
    // against the row's pinned generation.
    writeSessions(persistPath, [{ id: "wtgen", cwd: tmp, worktreeId: "gen-abc123" }])
    const resumer = makeRecordingResumer([])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    const outcome = await reg.resumeOnBoot("wtgen")
    expect(outcome).toEqual({ status: "skipped", reason: "worktree-generation-mismatch" })
    expect(resumer).not.toHaveBeenCalled()
    // Nothing is broken about the session — no attempt counted.
    expect(reg.get("wtgen")?.resumeAttempts ?? 0).toBe(0)
    reg.shutdown()
  })

  it("leaves the row dead-but-lazy-resumable (NO fresh spawn) when the adapter rejects the id", async () => {
    writeSessions(persistPath, [{ id: "notfound" }])
    const resumer = vi.fn(async () => null) // adapter: "session not found"
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    const outcome = await reg.resumeOnBoot("notfound")
    expect(outcome).toEqual({ status: "failed", reason: "resume-failed" })
    expect(resumer).toHaveBeenCalledTimes(1)
    // Still dead + still the same id (no new descriptor minted): the eager pass
    // never fresh-spawns; that fallback is session_restart's alone.
    expect(reg.get("notfound")?.status).toBe("killed")
    expect(reg.get("notfound")?.adapterSessionId).toBe("acp-notfound")
    expect(reg.list().length).toBe(1)
    // A failed resume counts an attempt.
    expect(reg.get("notfound")?.resumeAttempts).toBe(1)
    reg.shutdown()
  })

  it("is idempotent — a second resumeOnBoot on an already-live row is a no-op skip", async () => {
    writeSessions(persistPath, [{ id: "dup" }])
    const resumer = makeRecordingResumer([])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    expect(await reg.resumeOnBoot("dup")).toEqual({ status: "resumed" })
    expect(await reg.resumeOnBoot("dup")).toEqual({ status: "skipped", reason: "already-live" })
    expect(resumer).toHaveBeenCalledTimes(1)
    reg.shutdown()
  })

  it("skips an unknown id", async () => {
    writeSessions(persistPath, [{ id: "real" }])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeRecordingResumer([]) })
    expect(await reg.resumeOnBoot("ghost-that-never-existed")).toEqual({
      status: "skipped",
      reason: "unknown",
    })
    reg.shutdown()
  })
})

describe("runEagerResumePass (bounded boot pass)", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "eager-pass-"))
    persistPath = join(tmp, "sessions.json")
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("resumes every daemon-restart candidate (idle + mid-turn) with no prompt, leaving non-candidates dead", async () => {
    writeSessions(persistPath, [
      { id: "idle", busy: false },
      { id: "midturn", busy: true },
      { id: "userkill", status: "killed" }, // not a candidate (no daemon-restart)
    ])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeRecordingResumer([]) })

    const summary = await runEagerResumePass({ registry: reg, concurrency: 4 })

    expect(summary).toEqual({ enabled: true, candidates: 2, resumed: 2, failed: 0, skipped: 0 })
    expect(reg.get("idle")?.status).toBe("running")
    expect(reg.get("midturn")?.status).toBe("running")
    expect(reg.get("userkill")?.status).toBe("killed")
    reg.shutdown()
  })

  it("orders candidates by lastActivityAt desc (most-recent first)", async () => {
    writeSessions(persistPath, [
      { id: "old", lastActivityAt: "2026-07-23T01:00:00Z" },
      { id: "newest", lastActivityAt: "2026-07-23T03:00:00Z" },
      { id: "mid", lastActivityAt: "2026-07-23T02:00:00Z" },
    ])
    const calls: string[] = []
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeRecordingResumer(calls) })

    // concurrency 1 so call order == candidate order.
    await runEagerResumePass({ registry: reg, concurrency: 1 })
    expect(calls).toEqual(["newest", "mid", "old"])
    reg.shutdown()
  })

  it("respects the concurrency cap — never more than N adapters spawning at once", async () => {
    writeSessions(
      persistPath,
      Array.from({ length: 6 }, (_, i) => ({ id: `s${i}` })),
    )
    const { resumer, maxConcurrent } = makeConcurrencyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    const summary = await runEagerResumePass({ registry: reg, concurrency: 2 })
    expect(summary.resumed).toBe(6)
    expect(maxConcurrent()).toBeLessThanOrEqual(2)
    // And it genuinely ran concurrently (not serialized) — proves the cap isn't
    // just 1 by accident.
    expect(maxConcurrent()).toBe(2)
    reg.shutdown()
  })

  it("excludes rows the daemon does not serve (cross-process gate)", async () => {
    writeSessions(persistPath, [
      { id: "mine", workspaceSlug: "alpha" },
      { id: "theirs", workspaceSlug: "beta" },
    ])
    const calls: string[] = []
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeRecordingResumer(calls) })

    const summary = await runEagerResumePass({
      registry: reg,
      concurrency: 4,
      isServed: d => d.workspaceSlug === "alpha",
    })
    expect(summary.candidates).toBe(1)
    expect(calls).toEqual(["mine"])
    expect(reg.get("theirs")?.status).toBe("killed")
    reg.shutdown()
  })

  it("counts a failed candidate (cwd gone) in the summary", async () => {
    writeSessions(persistPath, [
      { id: "good" },
      { id: "gone", cwd: join(tmp, "vanished") },
    ])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeRecordingResumer([]) })

    const summary = await runEagerResumePass({ registry: reg, concurrency: 4 })
    expect(summary.candidates).toBe(2)
    expect(summary.resumed).toBe(1)
    expect(summary.failed).toBe(1)
    reg.shutdown()
  })

  it("excludes a cap-exhausted row from the candidate set entirely", async () => {
    writeSessions(persistPath, [
      { id: "live" },
      { id: "capped", resumeAttempts: MAX_RESUME_ATTEMPTS },
    ])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeRecordingResumer([]) })

    const summary = await runEagerResumePass({ registry: reg, concurrency: 4 })
    expect(summary.candidates).toBe(1)
    expect(summary.resumed).toBe(1)
    reg.shutdown()
  })
})

describe("eager resume-on-boot: opt-in semantics (knob off == pass never runs)", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "eager-knob-"))
    persistPath = join(tmp, "sessions.json")
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("with the knob OFF (pass not invoked) the ghosts stay killed, and lazy resume-on-prompt still revives them", async () => {
    writeSessions(persistPath, [{ id: "a" }, { id: "b" }])
    const resumer = makeRecordingResumer([])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    // Knob off ⇒ serve.ts never calls the pass ⇒ nothing spawns at boot.
    expect(reg.get("a")?.status).toBe("killed")
    expect(reg.get("b")?.status).toBe("killed")
    expect(resumer).not.toHaveBeenCalled()

    // Lazy path is unconditional — a prompt still resumes in place.
    await reg.sendPrompt("a", "continue")
    expect(reg.get("a")?.status).toBe("running")
    expect(reg.get("b")?.status).toBe("killed") // untouched, still lazy-resumable

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })
})

describe("eager resume-on-boot runs after supervisor re-arm (§5 ordering)", () => {
  let tmp: string
  let sessionsPath: string
  let policiesPath: string
  let workspace: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "eager-order-"))
    sessionsPath = join(tmp, "sessions.json")
    policiesPath = join(tmp, "policies.json")
    workspace = tmp
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("a lone-session policy on an idle watched session survives the restart, and the eager pass brings the session back live", async () => {
    const id = "sess_watched"
    writeFileSync(
      sessionsPath,
      JSON.stringify({
        savedAt: "2026-07-23T00:00:00Z",
        sessions: [
          {
            id,
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "claude (agent)",
            pid: null,
            status: "running",
            startedAt: "2026-07-23T00:00:00Z",
            busy: false,
            adapterSlug: "claude-code",
            adapterSessionId: "acp-watched",
            cwd: workspace,
          },
        ],
      }),
    )
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
              startedAt: "2026-07-23T00:00:00Z",
              retries: 0,
            },
          },
        ],
      }),
    )

    const bus = createSessionEventBus()
    // Real boot order: registry FIRST (reclassifies + emits session:exited with
    // no supervisor listening) ...
    const reg = createSessionsRegistry({
      persistPath: sessionsPath,
      sessionEvents: bus,
      resumeAgent: makeRecordingResumer([]),
    })
    // ... THEN the supervisor re-arms from its own persist file ...
    const supervisor = createCompletionPolicySupervisor({
      registry: reg,
      sessionEvents: bus,
      workspace,
      persistPath: policiesPath,
    })
    // ... and ONLY THEN the eager pass runs (emitting session:resumed, never a
    // second session:exited).
    const summary = await runEagerResumePass({ registry: reg, concurrency: 4 })
    await new Promise(res => setTimeout(res, 30))

    expect(summary.resumed).toBe(1)
    expect(reg.get(id)?.status).toBe("running")
    // The restart cost this session its liveness, not its policy: the re-armed
    // lone-session gate must still be watching, and session:resumed must not
    // have cancelled it.
    const status = supervisor.getStatus("pol_watched")?.status
    expect(status).toBe("watching")
    reg.shutdown()
  })
})
