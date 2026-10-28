/**
 * Characterization tests: what the context subsystem does TODAY for the
 * policies the Pygmalion product really uses (auto-compact, percent ladder,
 * hard floor, compactRequiresOperator). A safety net for the context rework,
 * not a statement of what the behaviour should be.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CONTEXT_CONTINUITY_DEFAULTS,
  resolveContextContinuityPolicy,
  type ResolvedContextContinuityPolicy,
} from "../context-continuity.js"
import { resolveSpawnDefaults } from "../spawn-defaults.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"

interface Harness extends AgentSessionLike {
  prompts: string[]
}

/** Real adapters advertise compaction as a slash command (available-commands), never as a session mode. */
function harness(used: number, size: number, usedAfterCompact = 1_000): Harness {
  let current = used
  let advertised = false
  const h: Harness = {
    sessionId: "acp-pin",
    prompts: [],
    availableModes: [],
    async *send(message): AsyncIterable<AgentStreamEvent> {
      const text = (Array.isArray(message) ? message : [message])
        .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
        .join("")
      h.prompts.push(text)
      if (!advertised) {
        advertised = true
        yield { kind: "available-commands", commands: [{ name: "compact", description: "Compact the conversation" }] }
      }
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

const isCompact = (p: string): boolean => p.startsWith("/compact")

describe("context behaviour pinned before the rework (Pygmalion profile)", () => {
  let tmp: string
  let reg: SessionsRegistry

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctx-pin-"))
    reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, contextRescueSettleMs: 100 })
  })
  afterEach(() => {
    reg.shutdown()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  /** `reg.spawnAgent` stores the policy as given: it does not merge defaults. */
  const spawn = (h: AgentSessionLike, partial?: Partial<ResolvedContextContinuityPolicy>) =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: h,
      adapterSlug: "fake",
      ...(partial ? { contextContinuity: { ...CONTEXT_CONTINUITY_DEFAULTS, ...partial } } : {}),
    }).id

  const outputOf = (id: string): string[] => {
    const lines: string[] = []
    reg.attach(id, line => lines.push(line))?.()
    return lines
  }

  it("T1: auto-compact fires above the absolute token threshold", async () => {
    const h = harness(200_000, 1_000_000)
    const id = spawn(h, { mode: "auto", autoCompactAtTokens: 150_000 })
    await reg.sendPrompt(id, "work")
    await vi.waitFor(() => expect(h.prompts.filter(isCompact)).toHaveLength(1), { timeout: 5_000 })
    expect(reg.get(id)?.status).toBe("running")
  })

  it("T1b: autoCompactAtTokens 0 disables auto-compact", async () => {
    const h = harness(200_000, 1_000_000)
    const id = spawn(h, { mode: "auto", autoCompactAtTokens: 0 })
    await reg.sendPrompt(id, "work")
    await new Promise(r => setTimeout(r, 300))
    expect(h.prompts.some(isCompact)).toBe(false)
  })

  it("T2: compactRequiresOperator refuses an agent-sourced compaction, accepts the operator's", async () => {
    const h = harness(40, 100)
    const id = spawn(h, { mode: "auto", compactRequiresOperator: true })
    await expect(reg.sendPrompt(id, "/compact", { source: "agent:" + id })).rejects.toThrow(
      /requires the operator/,
    )
    await reg.sendPrompt(id, "/compact")
    expect(h.prompts.some(isCompact)).toBe(true)
  })

  it("T3: the hard-stop floor compacts automatically in auto mode and the session keeps running", async () => {
    const h = harness(95, 100, 10)
    const id = spawn(h, { mode: "auto", compactRequiresOperator: true })
    await reg.sendPrompt(id, "work")
    await vi.waitFor(() => expect(h.prompts.some(isCompact)).toBe(true), { timeout: 5_000 })
    await vi.waitFor(() => expect(outputOf(id).join("\n")).toMatch(/auto-compacted at the hard-stop floor/), { timeout: 5_000 })
    const desc = reg.get(id)!
    expect(desc.status).toBe("running")
    expect(desc.contextContinuityHardStopped).toBeFalsy()
  })

  it("T3b: the hard stop kills the session when compaction does not help", async () => {
    const h = harness(95, 100, 95)
    const id = spawn(h, { mode: "auto", compactRequiresOperator: true })
    await reg.sendPrompt(id, "work")
    await vi.waitFor(() => expect(reg.get(id)?.status).toBe("killed"), { timeout: 5_000 })
    expect(reg.get(id)?.endedReason).toBe("context-hard-stop")
  })

  it("T4: resolveContextContinuityPolicy fills defaults and keeps explicit values", () => {
    const filled = resolveContextContinuityPolicy(undefined, undefined, undefined, { mode: "auto", goal: true })
    expect(filled.autoCompactAtTokens).toBe(150_000)
    expect(filled.hardStopAtPct).toBe(90)
    expect(filled.warnAtPct).toBe(55)

    const explicit = resolveContextContinuityPolicy(undefined, undefined, undefined, {
      mode: "auto",
      autoCompactAtTokens: 0,
      warnAtPct: 70,
      compactAtPct: 80,
      continueFreshAtPct: 88,
      hardStopAtPct: 95,
    })
    expect(explicit.autoCompactAtTokens).toBe(0)
    expect(explicit.hardStopAtPct).toBe(95)
  })

  it("T4b: spawn defaults resolve contextContinuity by whole-object precedence", () => {
    const daemonDefault = {
      mode: "auto" as const,
      warnAtPct: 70,
      compactAtPct: 80,
      continueFreshAtPct: 88,
      hardStopAtPct: 95,
      autoCompactAtTokens: 0,
    }
    const defaults = { contextContinuity: daemonDefault }

    // Whole-object precedence: the Pygmalion brain gets 150k/55/65/75/90 while sessions without a policy inherit the daemon default entirely (auto-compact off here).
    const explicitInput = { mode: "auto" as const, compactRequiresOperator: true }
    const a = resolveSpawnDefaults(defaults, "fake", { contextContinuity: explicitInput })
    expect(a.contextContinuity).toBe(explicitInput)
    expect(a.contextContinuity).not.toBe(daemonDefault)
    const resolvedA = resolveContextContinuityPolicy(undefined, undefined, undefined, a.contextContinuity)
    expect(resolvedA.autoCompactAtTokens).toBe(150_000)
    expect(resolvedA.warnAtPct).toBe(55)
    expect(resolvedA.hardStopAtPct).toBe(90)

    const b = resolveSpawnDefaults(defaults, "fake", {})
    expect(b.contextContinuity).toBe(daemonDefault)
    const resolvedB = resolveContextContinuityPolicy(undefined, undefined, undefined, b.contextContinuity)
    expect(resolvedB.autoCompactAtTokens).toBe(0)
    expect(resolvedB.warnAtPct).toBe(70)
    expect(resolvedB.hardStopAtPct).toBe(95)
  })

  it("T5: without a policy the floor does not act and the session keeps taking prompts", async () => {
    // A3 inverts this: the floor must hold without a policy.
    const h = harness(95, 100)
    const id = spawn(h)
    await reg.sendPrompt(id, "work")
    await new Promise(r => setTimeout(r, 300))
    expect(h.prompts.some(isCompact)).toBe(false)
    expect(reg.get(id)?.status).toBe("running")
    const before = h.prompts.length
    await reg.sendPrompt(id, "more")
    expect(h.prompts.length).toBe(before + 1)
  })

  it("T5b: without a policy auto-compact still fires from the default token threshold", async () => {
    const h = harness(200_000, 1_000_000)
    const id = spawn(h)
    await reg.sendPrompt(id, "work")
    await vi.waitFor(() => expect(h.prompts.filter(isCompact)).toHaveLength(1), { timeout: 5_000 })
  })

  it("T6: at 75% in auto mode with no adapter resolver the ladder hard-stops the session and no compaction reaches the harness", async () => {
    // Observed identical over 5 runs. The transcript lines (checkpoint order) vary between runs, so only the prompts and the final state are pinned.
    const h = harness(150_000, 200_000)
    const id = spawn(h, { mode: "auto" })
    await reg.sendPrompt(id, "work")
    await vi.waitFor(() => expect(reg.get(id)?.status).toBe("killed"), { timeout: 5_000 })
    await new Promise(r => setTimeout(r, 300))
    expect(h.prompts).toEqual(["work"])
    expect(reg.get(id)?.status).toBe("killed")
    expect(reg.get(id)?.endedReason).toBe("context-hard-stop")
  })
})
