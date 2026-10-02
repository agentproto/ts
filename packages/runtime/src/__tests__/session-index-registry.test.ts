import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { readSessionIndex, sessionIndexPath } from "../session-index.js"

/**
 * Registry wiring for the index sidecar: written on spawn, rename and
 * (throttled) turn-end, and the trailing flush never drops the final state.
 * Hermetic: a tmpdir persistPath gives the registry its own transcript root.
 */

let tmp: string
let persistPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "session-index-reg-"))
  persistPath = join(tmp, "sessions.json")
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function promptText(message: unknown): string {
  const blocks = Array.isArray(message) ? message : [message]
  return blocks.map(b => (typeof b === "string" ? b : (b as { text?: string }).text ?? "")).join("")
}

function makeAgent(reply: string): AgentSessionLike {
  return {
    sessionId: "acp-index-1",
    async *send(message: unknown) {
      void promptText(message)
      yield { kind: "text-delta", text: reply }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

function spawn(reg: ReturnType<typeof createSessionsRegistry>, reply = "hello back") {
  return reg.spawnAgent({
    id: "sess_idx",
    workspaceSlug: "default",
    cwd: tmp,
    adapterSlug: "claude-code",
    agentSession: makeAgent(reply),
    label: "index me",
  })
}

describe("registry index sidecar", () => {
  it("writes an index at spawn", () => {
    const reg = createSessionsRegistry({ persistPath })
    spawn(reg)
    const idx = readSessionIndex("sess_idx", reg.transcriptBaseDir)
    expect(idx).toMatchObject({ id: "sess_idx", kind: "agent-cli", status: "running", alive: true, label: "index me", adapter: "claude-code" })
    expect(sessionIndexPath("sess_idx", reg.transcriptBaseDir)).toContain("sess_idx")
    reg.shutdown()
  })

  it("writes the index on rename immediately", () => {
    const reg = createSessionsRegistry({ persistPath })
    spawn(reg)
    reg.renameSession("sess_idx", { label: "chat 16:56:28" })
    expect(readSessionIndex("sess_idx", reg.transcriptBaseDir)?.label).toBe("chat 16:56:28")
    expect(readSessionIndex("sess_idx", reg.transcriptBaseDir)?.renamedByUser).toBe(true)
    reg.shutdown()
  })

  it("writes the index on turn-end, throttled — flush lands the final state", async () => {
    const reg = createSessionsRegistry({ persistPath })
    spawn(reg)

    await reg.sendPrompt("sess_idx", "what did you find?")
    // Turn-end only SCHEDULES the write; the explicit flush is the trailing
    // write the throttle would have fired.
    reg.flushSessionIndexes()
    let idx = readSessionIndex("sess_idx", reg.transcriptBaseDir)
    expect(idx?.turnsCompleted).toBe(1)
    expect(idx?.lastUserPrompt?.text).toBe("what did you find?")
    expect(idx?.lastOutputText).toBe("hello back")

    // A second rapid turn must not lose the final state to the throttle.
    await reg.sendPrompt("sess_idx", "and now?")
    reg.flushSessionIndexes()
    idx = readSessionIndex("sess_idx", reg.transcriptBaseDir)
    expect(idx?.turnsCompleted).toBe(2)
    expect(idx?.lastUserPrompt?.text).toBe("and now?")
    reg.shutdown()
  })

  it("flushes the index on shutdown", async () => {
    const reg = createSessionsRegistry({ persistPath })
    spawn(reg)
    await reg.sendPrompt("sess_idx", "bye")
    reg.shutdown()
    expect(readSessionIndex("sess_idx", reg.transcriptBaseDir)?.lastUserPrompt?.text).toBe("bye")
  })
})
