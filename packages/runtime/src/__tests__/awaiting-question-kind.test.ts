/**
 * `SessionAwaitingQuestion.kind`: every daemon writer of the awaiting
 * question says WHAT kind of wait it is (a tool permission, the daemon's own
 * context question, or a question the harness or model asked), while the
 * operator override leaves it unclassified.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CONTEXT_CONTINUITY_DEFAULTS,
  type ResolvedContextContinuityPolicy,
} from "../context-continuity.js"
import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"

/** A fake harness that yields the same scripted events on every turn. */
function harness(events: AgentStreamEvent[]): AgentSessionLike {
  return {
    sessionId: "acp-kind",
    async *send(): AsyncIterable<AgentStreamEvent> {
      for (const e of events) yield e
    },
    async cancel() {},
    async close() {},
  }
}

describe("awaiting question kind", () => {
  let tmp: string
  let bus: SessionEventBus
  let reg: SessionsRegistry

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "aq-kind-"))
    bus = createSessionEventBus()
    reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
  })
  afterEach(() => {
    reg.shutdown()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const spawn = (h: AgentSessionLike, policy?: ResolvedContextContinuityPolicy) =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: h,
      adapterSlug: "fake",
      ...(policy ? { contextContinuity: policy } : {}),
    }).id

  it("a driver-reported permission request (tool name, allow/deny options) is kind permission", async () => {
    const id = spawn(
      harness([
        {
          kind: "agent-prompt",
          toolCallId: "tc-1",
          toolName: "Bash",
          text: 'Allow "Bash"?',
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        { kind: "turn-end", reason: "awaiting-input" },
      ]),
    )
    await reg.sendPrompt(id, "go")
    expect(reg.get(id)?.awaitingQuestion?.kind).toBe("permission")
  })

  it("a driver-reported prompt with no tool (a plain question with options) is kind harness", async () => {
    const id = spawn(
      harness([
        { kind: "agent-prompt", toolCallId: "q-1", text: "Which branch?", options: ["main", "dev"] },
        { kind: "turn-end", reason: "awaiting-input" },
      ]),
    )
    await reg.sendPrompt(id, "go")
    expect(reg.get(id)?.awaitingQuestion).toMatchObject({ text: "Which branch?", kind: "harness" })
  })

  it("an AIP-45 request of question stays kind harness even when it names a tool", async () => {
    const id = spawn(
      harness([
        {
          kind: "agent-prompt",
          toolCallId: "q-2",
          toolName: "AskUserQuestion",
          request: "question",
          text: "Which branch?",
          options: [{ optionId: "main", name: "main", kind: "allow_once" }],
        },
        { kind: "turn-end", reason: "awaiting-input" },
      ]),
    )
    await reg.sendPrompt(id, "go")
    expect(reg.get(id)?.awaitingQuestion).toMatchObject({ text: "Which branch?", kind: "harness" })
  })

  it("an AIP-45 plan-approval request, or allow/reject option kinds without a tool name, are kind permission", async () => {
    const plan = spawn(
      harness([
        { kind: "agent-prompt", toolCallId: "p-1", request: "plan-approval", options: ["Approve", "Reject"] },
        { kind: "turn-end", reason: "awaiting-input" },
      ]),
    )
    await reg.sendPrompt(plan, "go")
    expect(reg.get(plan)?.awaitingQuestion?.kind).toBe("permission")

    const optionKinds = spawn(
      harness([
        {
          kind: "agent-prompt",
          toolCallId: "p-2",
          options: [{ optionId: "ok", name: "Proceed", kind: "allow_always" }],
        },
        { kind: "turn-end", reason: "awaiting-input" },
      ]),
    )
    await reg.sendPrompt(optionKinds, "go")
    expect(reg.get(optionKinds)?.awaitingQuestion?.kind).toBe("permission")
  })

  it("the context ask at the continue-fresh threshold is kind context", async () => {
    const policy: ResolvedContextContinuityPolicy = {
      ...CONTEXT_CONTINUITY_DEFAULTS,
      mode: "ask",
      warnAtPct: 10,
      compactAtPct: 15,
      continueFreshAtPct: 20,
      hardStopAtPct: 90,
      label: "ask",
    }
    const id = spawn(
      harness([
        { kind: "usage_update", size: 100, used: 25 },
        { kind: "turn-end" },
      ]),
      policy,
    )
    await reg.sendPrompt(id, "go")
    expect(reg.get(id)?.awaitingQuestion).toMatchObject({
      text: "Context is at 25%. Continue fresh to avoid losing continuity?",
      kind: "context",
    })
  })

  it("the heuristic question from a plain-text turn is kind harness, and turn-end carries it", async () => {
    const turnEnd = vi.fn()
    bus.on("session:turn-end", turnEnd)
    const id = spawn(
      harness([
        { kind: "text-delta", text: "Which environment should I target?\n1. staging\n2. production\n" },
        { kind: "turn-end", reason: "awaiting-input" },
      ]),
    )
    await reg.sendPrompt(id, "go")
    const expected = {
      text: "Which environment should I target?",
      options: ["staging", "production"],
      source: "heuristic",
      kind: "harness",
    }
    expect(reg.get(id)?.awaitingQuestion).toEqual(expected)
    expect(turnEnd).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, question: expected }))
  })

  it("the session_flag_status override leaves kind absent, and awaitingInput:false clears the question", async () => {
    const id = spawn(
      harness([
        { kind: "agent-prompt", toolCallId: "tc-2", toolName: "Bash", options: ["Allow", "Deny"] },
        { kind: "turn-end", reason: "awaiting-input" },
      ]),
    )
    await reg.sendPrompt(id, "go")
    expect(reg.get(id)?.awaitingQuestion?.kind).toBe("permission")

    reg.flagAwaitingInput(id, { awaitingInput: true, question: "Ship it?", reason: "operator" })
    const q = reg.get(id)?.awaitingQuestion
    expect(q).toEqual({ text: "Ship it?", source: "structured" })
    expect(q && "kind" in q).toBe(false)

    reg.flagAwaitingInput(id, { awaitingInput: false, reason: "operator" })
    expect(reg.get(id)?.awaitingQuestion).toBeUndefined()
  })
})
