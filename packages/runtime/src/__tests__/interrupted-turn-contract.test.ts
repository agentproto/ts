import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

/**
 * The interrupted-turn contract (§4 of the session-survivability plan):
 * DROP-not-retry. A turn that was in flight when the daemon died is never
 * auto-re-run. On resume we surface the fact (a derived `interrupted` field, a
 * `session:resumed` bus event, and a synthetic banner) so the caller can decide
 * to re-issue — but we never replay the prompt ourselves.
 */

/** Seed a persisted running agent-cli row (daemon-restart shape) so the boot
 *  reload reclassifies it to killed + endedReason:"daemon-restart", with
 *  killedMidTurn derived from `busy`. */
function seedRow(persistPath: string, busy: boolean): string {
  const id = "sess_resumeme"
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
          busy,
          adapterSlug: "claude-code",
          adapterSessionId: "acp-resume-me",
          cwd: "/tmp",
        },
      ],
    }),
  )
  return id
}

/** A resumer that returns a fresh session which completes one turn. */
function makeResumer(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const fresh: AgentSessionLike = {
      sessionId: "acp-resume-me",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    return fresh
  })
}

describe("interrupted-turn contract", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "interrupted-turn-"))
    persistPath = join(tmp, "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("sets the derived `interrupted` field after a mid-turn daemon restart, and clears it after a successful turn-end", async () => {
    const id = seedRow(persistPath, /* busy */ true)
    const reg = createSessionsRegistry({ persistPath, resumeAgent: makeResumer() })

    // Boot reclassification: killed + daemon-restart + killedMidTurn, so the
    // derived surface field reads interrupted:true.
    const ghost = reg.get(id)
    expect(ghost?.status).toBe("killed")
    expect(ghost?.endedReason).toBe("daemon-restart")
    expect(ghost?.killedMidTurn).toBe(true)
    expect(ghost?.interrupted).toBe(true)
    expect(reg.list().find(d => d.id === id)?.interrupted).toBe(true)

    // Re-prompt → resume + a fresh successful turn clears the markers.
    await reg.sendPrompt(id, "continue")

    const after = reg.get(id)
    expect(after?.status).toBe("running")
    expect(after?.killedMidTurn).toBeUndefined()
    expect(after?.endedReason).toBeUndefined()
    expect(after?.interrupted).toBeUndefined()
    // Settle the append-stream's async open before teardown (see below).
    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("`interrupted` is never persisted — it re-derives from killedMidTurn/endedReason on reload", () => {
    const id = seedRow(persistPath, /* busy */ true)
    const reg = createSessionsRegistry({ persistPath })
    expect(reg.get(id)?.interrupted).toBe(true)
    reg.shutdown()

    const raw = JSON.parse(readFileSync(persistPath, "utf8")) as {
      sessions: Array<Record<string, unknown>>
    }
    const row = raw.sessions.find(s => s.id === id)!
    expect("interrupted" in row).toBe(false)
    // The underlying durable markers ARE persisted, so a fresh boot re-derives.
    expect(row.killedMidTurn).toBe(true)
    expect(row.endedReason).toBe("daemon-restart")
  })

  it("resume of a killedMidTurn row emits session:resumed{interrupted:true} and writes the interrupted banner (ring + transcript)", async () => {
    const id = seedRow(persistPath, /* busy */ true)
    const bus = createSessionEventBus()
    const resumedHandler = vi.fn()
    bus.on("session:resumed", resumedHandler)

    const reg = createSessionsRegistry({
      persistPath,
      sessionEvents: bus,
      resumeAgent: makeResumer(),
    })

    // Capture durable transcript records (delivered synchronously on write).
    const records: Array<Record<string, unknown>> = []
    reg.subscribeToRecords(id, rec => records.push(rec))

    await reg.sendPrompt(id, "continue")

    // Bus event: interrupted:true, resumedFrom daemon-restart.
    expect(resumedHandler).toHaveBeenCalledTimes(1)
    expect(resumedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:resumed",
        sessionId: id,
        interrupted: true,
        resumedFrom: "daemon-restart",
      }),
    )

    // Ring line (mirrors the plain resume banner mechanism).
    const lines: string[] = []
    const unsub = reg.attach(id, line => lines.push(line))
    if (unsub) unsub()
    expect(
      lines.some(l => l.includes("interrupted and was NOT re-run")),
    ).toBe(true)

    // Durable transcript record: a "notice" carrying the same banner.
    const notice = records.find(r => r.kind === "notice")
    expect(notice).toBeDefined()
    expect(String(notice?.text)).toContain("interrupted and was NOT re-run")
    // Let the append-stream's async open settle before teardown removes the
    // tmp dir (otherwise the fd open races rmSync and logs a benign ENOENT).
    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("resume of an idle-killed row emits session:resumed{interrupted:false} and writes NO banner", async () => {
    const id = seedRow(persistPath, /* busy */ false)
    const bus = createSessionEventBus()
    const resumedHandler = vi.fn()
    bus.on("session:resumed", resumedHandler)

    const reg = createSessionsRegistry({
      persistPath,
      sessionEvents: bus,
      resumeAgent: makeResumer(),
    })

    // Sanity: idle at death → not interrupted.
    expect(reg.get(id)?.killedMidTurn).toBe(false)
    expect(reg.get(id)?.interrupted).toBeUndefined()

    const records: Array<Record<string, unknown>> = []
    reg.subscribeToRecords(id, rec => records.push(rec))

    await reg.sendPrompt(id, "continue")

    expect(resumedHandler).toHaveBeenCalledTimes(1)
    expect(resumedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:resumed",
        sessionId: id,
        interrupted: false,
        resumedFrom: "daemon-restart",
      }),
    )

    // No interrupted banner — nothing was in flight to warn about.
    const lines: string[] = []
    const unsub = reg.attach(id, line => lines.push(line))
    if (unsub) unsub()
    expect(lines.some(l => l.includes("was NOT re-run"))).toBe(false)
    expect(records.find(r => r.kind === "notice")).toBeUndefined()
    // Settle the append-stream's async open before teardown (see above).
    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })
})
