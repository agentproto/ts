import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canResume,
  createSessionsRegistry,
  isResumable,
  MAX_RESUME_ATTEMPTS,
  ResumeDisabledError,
  type AgentSessionLike,
  type SessionDescriptor,
} from "../sessions.js"

/**
 * Resume attempt bookkeeping (§5 "Cap/backoff — no resurrect-forever" of the
 * session-survivability plan). A session whose adapter fails to resume must not
 * be retried on every prompt forever: `resumeAttempts` (persisted) is bumped on
 * every FAILED in-place resume, and once it reaches MAX_RESUME_ATTEMPTS the
 * lazy path stops spawning and fails loud ("use session_restart"). A successful
 * turn-end resets the counter. Because the counter is persisted, the cap also
 * bounds a launchd KeepAlive daemon crash-loop across boots.
 */

/** Seed a persisted running agent-cli row (daemon-restart shape) so the boot
 *  reload reclassifies it to killed + endedReason:"daemon-restart". `busy`
 *  false → idle-killed (no interrupted banner in the way). Extra descriptor
 *  fields (e.g. a pre-seeded resumeAttempts) can be merged via `over`. */
function seedRow(
  persistPath: string,
  over: Partial<SessionDescriptor> = {},
): string {
  const id = "sess_capme"
  writeFileSync(
    persistPath,
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
          adapterSessionId: "acp-cap-me",
          cwd: "/tmp",
          ...over,
        },
      ],
    }),
  )
  return id
}

/** A resumer that always fails (rejects) — the broken-adapter case. */
function makeFailingResumer(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    throw new Error("adapter refused resume: session not found")
  })
}

/** A healthy resumer whose fresh session completes one turn. */
function makeHealthyResumer(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const fresh: AgentSessionLike = {
      sessionId: "acp-cap-me",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    return fresh
  })
}

/** Drive a prompt and swallow the expected rejection, returning the error so
 *  the caller can assert on it. */
async function promptExpectingFailure(
  reg: ReturnType<typeof createSessionsRegistry>,
  id: string,
): Promise<unknown> {
  try {
    await reg.sendPrompt(id, "continue")
    return undefined
  } catch (err) {
    return err
  }
}

describe("canResume (cap-aware eligibility)", () => {
  const base = (over: Partial<SessionDescriptor> = {}): SessionDescriptor => ({
    id: "sess_x",
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude (agent)",
    pid: null,
    status: "killed",
    startedAt: "2026-07-23T00:00:00Z",
    adapterSlug: "claude-code",
    adapterSessionId: "acp-abc",
    cwd: "/tmp",
    ...over,
  })

  it("resumable row under the cap → true", () => {
    expect(canResume(base({ resumeAttempts: MAX_RESUME_ATTEMPTS - 1 }))).toBe(true)
    expect(canResume(base())).toBe(true) // no attempts recorded yet
  })

  it("resumable row at/over the cap → false", () => {
    expect(canResume(base({ resumeAttempts: MAX_RESUME_ATTEMPTS }))).toBe(false)
    expect(canResume(base({ resumeAttempts: MAX_RESUME_ATTEMPTS + 5 }))).toBe(false)
  })

  it("layers on isResumable — an unresumable row is never canResume, cap or no cap", () => {
    // PTY is never resumable regardless of the attempt count.
    expect(isResumable(base({ kind: "terminal", pty: true }))).toBe(false)
    expect(canResume(base({ kind: "terminal", pty: true, resumeAttempts: 0 }))).toBe(false)
  })
})

describe("resume attempt cap + backoff", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "resume-cap-"))
    persistPath = join(tmp, "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("caps failed resumes at MAX_RESUME_ATTEMPTS: the next prompt reports 'resume disabled' and attempts no further spawn", async () => {
    const id = seedRow(persistPath)
    const resumer = makeFailingResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    // MAX_RESUME_ATTEMPTS prompts each spawn the adapter, which fails; the
    // counter climbs 1..MAX and each prompt surfaces the dead session (not yet
    // the disabled error).
    for (let i = 1; i <= MAX_RESUME_ATTEMPTS; i++) {
      const err = await promptExpectingFailure(reg, id)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(ResumeDisabledError)
      expect(reg.get(id)?.resumeAttempts).toBe(i)
    }
    expect(resumer).toHaveBeenCalledTimes(MAX_RESUME_ATTEMPTS)

    // The NEXT prompt trips the cap: fail-loud ResumeDisabledError, NO further
    // spawn attempted (call count stays pinned at the cap).
    const capped = await promptExpectingFailure(reg, id)
    expect(capped).toBeInstanceOf(ResumeDisabledError)
    expect((capped as ResumeDisabledError).message).toBe(
      `resume disabled after ${MAX_RESUME_ATTEMPTS} failed attempts — use session_restart`,
    )
    expect(resumer).toHaveBeenCalledTimes(MAX_RESUME_ATTEMPTS)

    reg.shutdown()
  })

  it("stamps lastResumeAt on a failed resume", async () => {
    const id = seedRow(persistPath)
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeFailingResumer() })

    expect(reg.get(id)?.lastResumeAt).toBeUndefined()
    await promptExpectingFailure(reg, id)

    const after = reg.get(id)
    expect(after?.resumeAttempts).toBe(1)
    expect(typeof after?.lastResumeAt).toBe("string")
    expect(Number.isNaN(Date.parse(after!.lastResumeAt!))).toBe(false)

    reg.shutdown()
  })

  it("a healthy resume never increments the counter", async () => {
    const id = seedRow(persistPath)
    const resumer = makeHealthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    await reg.sendPrompt(id, "continue")

    expect(resumer).toHaveBeenCalledTimes(1)
    const after = reg.get(id)
    expect(after?.status).toBe("running")
    expect(after?.resumeAttempts ?? 0).toBe(0)
    expect(after?.lastResumeAt).toBeUndefined()

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("resets resumeAttempts to 0 after a successful turn-end (recovers before the cap)", async () => {
    const id = seedRow(persistPath)
    // Fail the first two resumes, succeed on the third.
    let call = 0
    const resumer = vi.fn(async () => {
      call++
      if (call < MAX_RESUME_ATTEMPTS) {
        throw new Error("adapter still warming up")
      }
      const fresh: AgentSessionLike = {
        sessionId: "acp-cap-me",
        async *send() {
          yield { kind: "turn-end", reason: "completed" }
        },
        async cancel() {},
        async close() {},
      }
      return fresh
    })
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    // Two failures → counter at MAX-1, still under the cap.
    for (let i = 1; i < MAX_RESUME_ATTEMPTS; i++) {
      await promptExpectingFailure(reg, id)
      expect(reg.get(id)?.resumeAttempts).toBe(i)
    }

    // Third prompt resumes cleanly and runs a turn to completion → counter and
    // lastResumeAt cleared.
    await reg.sendPrompt(id, "continue")
    const after = reg.get(id)
    expect(after?.status).toBe("running")
    expect(after?.resumeAttempts ?? 0).toBe(0)
    expect(after?.lastResumeAt).toBeUndefined()

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("round-trips resumeAttempts + lastResumeAt through persist/reload", async () => {
    const id = seedRow(persistPath)
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeFailingResumer() })

    await promptExpectingFailure(reg, id)
    await promptExpectingFailure(reg, id)
    expect(reg.get(id)?.resumeAttempts).toBe(2)
    const stampedAt = reg.get(id)?.lastResumeAt
    expect(typeof stampedAt).toBe("string")
    reg.shutdown()

    // Persisted to disk (both fields, unlike the derived `interrupted`).
    const raw = JSON.parse(readFileSync(persistPath, "utf8")) as {
      sessions: Array<Record<string, unknown>>
    }
    const row = raw.sessions.find(s => s.id === id)!
    expect(row.resumeAttempts).toBe(2)
    expect(row.lastResumeAt).toBe(stampedAt)

    // A fresh boot reads them back — the cap survives a daemon restart.
    const reg2 = createSessionsRegistry({ persistPath, resumeAgent: makeFailingResumer() })
    expect(reg2.get(id)?.resumeAttempts).toBe(2)
    expect(reg2.get(id)?.lastResumeAt).toBe(stampedAt)
    reg2.shutdown()
  })

  it("a row seeded already at the cap fails loud on the first prompt without ever spawning", async () => {
    const id = seedRow(persistPath, { resumeAttempts: MAX_RESUME_ATTEMPTS })
    const resumer = makeFailingResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })

    const err = await promptExpectingFailure(reg, id)
    expect(err).toBeInstanceOf(ResumeDisabledError)
    expect(resumer).not.toHaveBeenCalled()

    reg.shutdown()
  })
})
