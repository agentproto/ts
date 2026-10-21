/**
 * Autocompact in the daemon: an IDLE session whose context is above the
 * ABSOLUTE token threshold is compacted at the turn boundary, even when
 * the percent ladder would never fire (a 1M-token window at 200k tokens is
 * "20% full", deep inside the warn band).
 *
 * The compaction itself goes through the same `/compact` prompt the
 * `session_compact` verb uses. A short resume prompt follows it ONLY when
 * the session really had WORK IN PROGRESS when it was compacted (a pending
 * tool call, an unanswered prompt, a turn that died), never because the
 * session has a title or a goal. An idle session that was simply done gets
 * its context freed and nothing else.
 *
 * The compaction also carries the full transcript path and a reminder that
 * `transcript_search` / `transcript_read` exist: on the compact command
 * itself for a harness whose command takes an argument (claude-code), or as
 * a pending note on the next user prompt for the others.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CONTEXT_CONTINUITY_DEFAULTS } from "../context-continuity.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"

interface Harness extends AgentSessionLike {
  prompts: string[]
}

/** A fake harness that reports `used` tokens in a `size`-token window. */
function harness(used: number, size: number, usedAfterCompact = 1_000): Harness {
  let current = used
  const h: Harness = {
    sessionId: "acp-autocompact",
    prompts: [],
    availableModes: [{ id: "compact", name: "Compact" }],
    async *send(message): AsyncIterable<AgentStreamEvent> {
      const text = (Array.isArray(message) ? message : [message])
        .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
        .join("")
      h.prompts.push(text)
      if (text.startsWith("/compact") || text.startsWith("/compress")) {
        current = usedAfterCompact
      }
      yield { kind: "text-delta", text: "ok" }
      yield { kind: "usage_update", size, used: current }
      yield { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
  }
  return h
}

describe("autocompact at the turn boundary", () => {
  let tmp: string
  let reg: SessionsRegistry

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "autocompact-"))
    reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
  })
  afterEach(() => {
    reg.shutdown()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const spawn = (h: AgentSessionLike, autoCompactAtTokens: number, adapterSlug = "fake") =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: h,
      adapterSlug,
      contextContinuity: {
        ...CONTEXT_CONTINUITY_DEFAULTS,
        mode: "manual",
        autoCompactAtTokens,
      },
    }).id

  it("compacts an idle session above the absolute threshold on a 1M-token window", async () => {
    const h = harness(200_000, 1_000_000)
    const id = spawn(h, 150_000)
    await reg.sendPrompt(id, "do the thing")
    await vi.waitFor(() => expect(h.prompts.some(p => p.startsWith("/compact"))).toBe(true))
    // The percent ladder never fires here: 200k of 1M is 20%.
    expect(reg.get(id)?.status).toBe("running")
  })

  it("leaves a session below the threshold alone", async () => {
    const h = harness(10_000, 1_000_000)
    const id = spawn(h, 150_000)
    await reg.sendPrompt(id, "do the thing")
    await new Promise(r => setTimeout(r, 200))
    expect(h.prompts.some(p => p.startsWith("/compact"))).toBe(false)
  })

  it("never sends /compact to a harness that does not advertise compact support", async () => {
    const h = harness(200_000, 1_000_000)
    delete (h as { availableModes?: unknown }).availableModes
    const id = spawn(h, 150_000)
    await reg.sendPrompt(id, "do the thing")
    await new Promise(r => setTimeout(r, 200))
    expect(h.prompts.some(p => p.startsWith("/compact"))).toBe(false)
  })

  it("sends no resume prompt when the session was idle and nothing was in progress", async () => {
    // The compaction is the LAST thing this session receives: no resume
    // prompt, no extra turn, no wake-up. The old goal-based rule fired here
    // (the checkpoint goal falls back to the session title), which is
    // exactly the waste this rule exists to avoid.
    const h = harness(200_000, 1_000_000)
    const id = spawn(h, 150_000)
    await reg.sendPrompt(id, "do the thing")
    await vi.waitFor(() => expect(h.prompts.some(p => p.startsWith("/compact"))).toBe(true))
    await new Promise(r => setTimeout(r, 200))
    const after = h.prompts.filter(p => !p.startsWith("/compact"))
    expect(after.some(p => p.startsWith("[auto-compact]"))).toBe(false)
    // Only the user's own prompt and the compaction, nothing else.
    expect(h.prompts).toHaveLength(2)
  })

  it("injects a resume prompt when the last turn died on an error", async () => {
    // The session was in the middle of something: its last turn ended on
    // an error, so the compaction dropped live work and the session must
    // be told to carry on.
    const h = harness(200_000, 1_000_000)
    const original = h.send.bind(h)
    h.send = async function* (message) {
      for await (const evt of original(message)) {
        yield evt.kind === "turn-end" ? { ...evt, reason: "error" } : evt
      }
    }
    const id = spawn(h, 150_000)
    await reg.sendPrompt(id, "do the thing")
    await vi.waitFor(() =>
      expect(h.prompts.some(p => p.startsWith("[auto-compact]"))).toBe(true),
    )
    const resume = h.prompts.find(p => p.startsWith("[auto-compact]"))!
    expect(resume).toContain("events.jsonl")
    expect(resume).toContain("transcript_search")
    expect(resume).toContain("transcript_read")
  })

  it("carries the transcript path and the lookup tools on the compact command for claude-code", async () => {
    const h = harness(200_000, 1_000_000)
    const id = spawn(h, 150_000, "claude-code")
    await reg.sendPrompt(id, "do the thing")
    await vi.waitFor(() => expect(h.prompts.some(p => p.startsWith("/compact"))).toBe(true))
    const compact = h.prompts.find(p => p.startsWith("/compact"))!
    expect(compact).toContain("events.jsonl")
    expect(compact).toContain("transcript_search")
    expect(compact).toContain("transcript_read")
  })

  it("prepends the transcript note to the next user prompt on a harness without compact arguments", async () => {
    // No argument-taking compact command here: the reminder rides along
    // with the next prompt the session receives, exactly once, and it
    // never starts a turn of its own.
    const h = harness(200_000, 1_000_000)
    const id = spawn(h, 150_000)
    await reg.sendPrompt(id, "do the thing")
    await vi.waitFor(() => expect(h.prompts.some(p => p.startsWith("/compact"))).toBe(true))
    await new Promise(r => setTimeout(r, 200))
    const countBefore = h.prompts.length
    // The note alone never wakes the session.
    expect(h.prompts).toHaveLength(countBefore)

    await reg.sendPrompt(id, "next question")
    await vi.waitFor(() => expect(h.prompts.length).toBe(countBefore + 1))
    const delivered = h.prompts[countBefore]!
    expect(delivered).toContain("transcript_search")
    expect(delivered).toContain("transcript_read")
    expect(delivered).toContain("events.jsonl")
    expect(delivered).toContain("next question")

    // Consumed once: the next prompt carries no note.
    await reg.sendPrompt(id, "another question")
    await vi.waitFor(() => expect(h.prompts.length).toBe(countBefore + 2))
    expect(h.prompts[countBefore + 1]).not.toContain("transcript_search")
  })

  it("does not compact twice while the first compaction is in flight", async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    let compactCount = 0
    const h: Harness = {
      sessionId: "acp-autocompact-gated",
      prompts: [],
      availableModes: [{ id: "compact", name: "Compact" }],
      async *send(message): AsyncIterable<AgentStreamEvent> {
        const text = (Array.isArray(message) ? message : [message])
          .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
          .join("")
        h.prompts.push(text)
        if (text.startsWith("/compact")) {
          compactCount += 1
          await gate
        }
        yield { kind: "text-delta", text: "ok" }
        yield { kind: "usage_update", size: 1_000_000, used: 200_000 }
        yield { kind: "turn-end" }
      },
      async cancel() {},
      async close() {},
    }
    const id = spawn(h, 150_000)
    await reg.sendPrompt(id, "do the thing")
    await vi.waitFor(() => expect(compactCount).toBe(1))
    await new Promise(r => setTimeout(r, 200))
    expect(compactCount).toBe(1)
    release()
  })
})
