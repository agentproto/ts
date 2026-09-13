import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

/**
 * Fix C of the resume-honesty spec: the LAZY resume-on-prompt path
 * (`maybeResumeAgent`) revives a dead-but-lazy-resumable row in place when a
 * prompt arrives for it. Before this fix it only warned about a dropped
 * mid-turn prompt (`interrupted` — see interrupted-turn-contract.test.ts);
 * it never said anything when the ADAPTER ITSELF can't rehydrate a prior
 * conversation (`resumable: false`, e.g. hermes/mastra-agent), so a lazily-
 * revived hermes session looked exactly like a real continuation even
 * though it's a blank session wearing the old id.
 *
 * These tests mirror interrupted-turn-contract.test.ts's harness: seed a
 * persisted row, prompt it, and assert on the `session:resumed` bus event +
 * ring/transcript banner.
 */

function seedRow(
  persistPath: string,
  adapterSlug: string,
  resumable: boolean | undefined,
): string {
  const id = "sess_honesty"
  writeFileSync(
    persistPath,
    JSON.stringify({
      savedAt: "2026-07-23T00:00:00Z",
      sessions: [
        {
          id,
          kind: "agent-cli",
          workspaceSlug: "default",
          command: `${adapterSlug} (agent)`,
          pid: null,
          status: "running",
          startedAt: "2026-07-23T00:00:00Z",
          busy: false,
          adapterSlug,
          adapterSessionId: "conv-honesty",
          cwd: "/tmp",
          ...(resumable !== undefined ? { resumable } : {}),
        },
      ],
    }),
  )
  return id
}

function makeResumer(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const fresh: AgentSessionLike = {
      sessionId: "conv-honesty",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    return fresh
  })
}

describe("lazy resume-on-prompt honesty banner (Fix C)", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "resume-honesty-"))
    persistPath = join(tmp, "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("resumable:false: emits session:resumed{contextRestored:false} and writes the 'WITHOUT prior context' banner", async () => {
    const id = seedRow(persistPath, "hermes", false)
    const bus = createSessionEventBus()
    const resumedHandler = vi.fn()
    bus.on("session:resumed", resumedHandler)

    const reg = createSessionsRegistry({
      persistPath,
      sessionEvents: bus,
      resumeAgent: makeResumer(),
    })

    const records: Array<Record<string, unknown>> = []
    reg.subscribeToRecords(id, rec => records.push(rec))

    await reg.sendPrompt(id, "continue")

    expect(resumedHandler).toHaveBeenCalledTimes(1)
    expect(resumedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:resumed",
        sessionId: id,
        contextRestored: false,
      }),
    )

    const lines: string[] = []
    const unsub = reg.attach(id, line => lines.push(line))
    if (unsub) unsub()
    expect(
      lines.some(l => l.includes("resumed WITHOUT prior context")),
    ).toBe(true)

    const notice = records.find(r => r.kind === "notice")
    expect(notice).toBeDefined()
    expect(String(notice?.text)).toContain("resumed WITHOUT prior context")

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("claude-code (resumable:true) stays silent — no honesty banner, no contextRestored flag", async () => {
    const id = seedRow(persistPath, "claude-code", true)
    const bus = createSessionEventBus()
    const resumedHandler = vi.fn()
    bus.on("session:resumed", resumedHandler)

    const reg = createSessionsRegistry({
      persistPath,
      sessionEvents: bus,
      resumeAgent: makeResumer(),
    })

    const records: Array<Record<string, unknown>> = []
    reg.subscribeToRecords(id, rec => records.push(rec))

    await reg.sendPrompt(id, "continue")

    expect(resumedHandler).toHaveBeenCalledTimes(1)
    const event = resumedHandler.mock.calls[0]?.[0]
    expect(event.contextRestored).toBeUndefined()

    const lines: string[] = []
    const unsub = reg.attach(id, line => lines.push(line))
    if (unsub) unsub()
    expect(lines.some(l => l.includes("WITHOUT prior context"))).toBe(false)
    expect(records.find(r => r.kind === "notice")).toBeUndefined()

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("resumable unset (legacy row / adapter this fix hasn't reached) also stays silent — unchanged default behaviour", async () => {
    const id = seedRow(persistPath, "hermes", undefined)
    const bus = createSessionEventBus()
    const resumedHandler = vi.fn()
    bus.on("session:resumed", resumedHandler)

    const reg = createSessionsRegistry({
      persistPath,
      sessionEvents: bus,
      resumeAgent: makeResumer(),
    })

    await reg.sendPrompt(id, "continue")

    const event = resumedHandler.mock.calls[0]?.[0]
    expect(event.contextRestored).toBeUndefined()

    const lines: string[] = []
    const unsub = reg.attach(id, line => lines.push(line))
    if (unsub) unsub()
    expect(lines.some(l => l.includes("WITHOUT prior context"))).toBe(false)

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })
})
