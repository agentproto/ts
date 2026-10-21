/**
 * Autocompact in the daemon: an IDLE session whose context is above the
 * ABSOLUTE token threshold is compacted at the turn boundary — even when
 * the percent ladder would never fire (a 1M-token window at 200k tokens is
 * "20% full", deep inside the warn band).
 *
 * The compaction itself goes through the same `/compact` prompt the
 * `session_compact` verb uses, and a short resume prompt follows it ONLY
 * when a mission is in progress (the checkpoint's `goal` section).
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

  const spawn = (h: AgentSessionLike, autoCompactAtTokens: number) =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: h,
      adapterSlug: "fake",
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

  it("injects a resume prompt that cites the full transcript when a mission is in progress", async () => {
    const h = harness(200_000, 1_000_000)
    const id = spawn(h, 150_000)
    await reg.sendPrompt(id, "do the thing")
    await vi.waitFor(() =>
      expect(h.prompts.some(p => p.startsWith("[auto-compact]"))).toBe(true),
    )
    const resume = h.prompts.find(p => p.startsWith("[auto-compact]"))!
    expect(resume).toContain("events.jsonl")
    expect(resume).toContain("do the thing")
  })

  it("does not compact twice while the first compaction is in flight", async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    let compactCount = 0
    const h: Harness = {
      sessionId: "acp-autocompact-gated",
      prompts: [],
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
