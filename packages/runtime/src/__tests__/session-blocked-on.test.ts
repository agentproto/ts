/**
 * `SessionDescriptor.blockedOn` — surfaces what an in-flight turn is
 * currently waiting on, classified from the pending tool call:
 * "subagent" (`agent_start`) or "command" (shell/terminal tools).
 * Deliberately no "user" variant: waiting on the user is already
 * `awaitingInput`/`awaitingQuestion`.
 *
 * Lifecycle under test:
 *   set   — on tool-call whose name classifies
 *   clear — on the MATCHING tool-result only (pendingToolCallId guard),
 *           at turn start, and in the turn's finally (safety net when a
 *           tool-call never receives its result, e.g. a crashed child).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"

/** Deferred the test controls to pause the fake agent mid-turn. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

/** Agent session that yields the given events, pausing where `gate` is
 *  interleaved so the test can assert mid-turn descriptor state. */
function scriptedAgentSession(
  script: Array<AgentStreamEvent | { gate: Promise<void> }>,
): AgentSessionLike {
  return {
    sessionId: "scripted-sess",
    async *send() {
      for (const step of script) {
        if ("gate" in step) await step.gate
        else yield step
      }
    },
    async cancel() {},
    async close() {},
  }
}

describe("SessionDescriptor.blockedOn", () => {
  let tmp: string
  let transcriptDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "blocked-on-test-"))
    transcriptDir = join(tmp, "sessions")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it.each([
    ["agent_start", "subagent"],
    ["command_execute", "command"],
  ] as const)(
    "sets blockedOn=%s → %s on tool-call and clears it on the matching tool-result",
    async (toolName, expected) => {
      const gate = deferred()
      const registry = createSessionsRegistry({ persist: false, transcriptDir })
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: scriptedAgentSession([
          { kind: "tool-call", toolName, toolCallId: "tc-1" },
          { gate: gate.promise },
          { kind: "tool-result", toolName, toolCallId: "tc-1", result: "ok" },
          { kind: "turn-end", reason: "completed" },
        ]),
        adapterSlug: "claude-code",
      })

      const turn = registry.sendPrompt(desc.id, "go")
      // Let the generator advance past the tool-call and park on the gate.
      await new Promise(r => setTimeout(r, 25))
      const mid = registry.get(desc.id)
      expect(mid?.blockedOn).toBe(expected)
      expect(mid?.pendingToolCallId).toBe("tc-1")

      gate.resolve()
      await turn

      const after = registry.get(desc.id)
      expect(after?.blockedOn).toBeUndefined()
      expect(after?.pendingToolCallId).toBeUndefined()

      registry.shutdown()
    },
  )

  it("does not clear blockedOn on a nested tool-result with a different toolCallId", async () => {
    const gate = deferred()
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession([
        { kind: "tool-call", toolName: "agent_start", toolCallId: "outer" },
        // An interleaved fast tool finishing first must NOT clear the flag.
        { kind: "tool-result", toolName: "read_file", toolCallId: "inner", result: "x" },
        { gate: gate.promise },
        { kind: "tool-result", toolName: "agent_start", toolCallId: "outer", result: "ok" },
        { kind: "turn-end", reason: "completed" },
      ]),
      adapterSlug: "claude-code",
    })

    const turn = registry.sendPrompt(desc.id, "go")
    await new Promise(r => setTimeout(r, 25))
    const mid = registry.get(desc.id)
    expect(mid?.blockedOn).toBe("subagent")
    expect(mid?.pendingToolCallId).toBe("outer")

    gate.resolve()
    await turn
    expect(registry.get(desc.id)?.blockedOn).toBeUndefined()

    registry.shutdown()
  })

  it("finally net: a tool-call that never gets its tool-result still clears at turn end", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession([
        { kind: "tool-call", toolName: "terminal_start", toolCallId: "tc-orphan" },
        // Stream ends here: no tool-result, no turn-end (child crashed).
      ]),
      adapterSlug: "claude-code",
    })

    await registry.sendPrompt(desc.id, "go")

    const after = registry.get(desc.id)
    expect(after?.blockedOn).toBeUndefined()
    expect(after?.pendingToolCallId).toBeUndefined()

    registry.shutdown()
  })

  /**
   * Replays sess_79ef158f, which latched the flag in the wild:
   *   tool-call Terminal → error → (agent recovers, turn continues)
   * A failing tool reports `error` and NEVER a tool-result, so keying the
   * release on a matching tool-result left the session advertising
   * "blocked on command · toolu_01…" for the rest of the turn.
   */
  it("releases blockedOn when the blocking tool FAILS (error, never a tool-result)", async () => {
    const gate = deferred()
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession([
        { kind: "tool-call", toolName: "Terminal", toolCallId: "toolu_01Buvi" },
        { kind: "error", error: { message: "spawn failed" } },
        // Park mid-turn: the turn's finally has NOT run yet, so anything
        // still claiming "blocked" here is the latch, not the safety net.
        { gate: gate.promise },
        { kind: "turn-end", reason: "completed" },
      ]),
      adapterSlug: "claude-code",
    })

    const turn = registry.sendPrompt(desc.id, "go")
    await new Promise(r => setTimeout(r, 25))
    const mid = registry.get(desc.id)
    expect(mid?.busy).toBe(true)
    expect(mid?.blockedOn).toBeUndefined()
    expect(mid?.pendingToolCallId).toBeUndefined()

    gate.resolve()
    await turn
    registry.shutdown()
  })

  it("releases blockedOn on the next assistant text-delta (adapters that never emit a tool-result)", async () => {
    const gate = deferred()
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession([
        { kind: "tool-call", toolName: "command_execute", toolCallId: "tc-1" },
        // The model has the floor again — whatever the adapter did or didn't
        // emit, it is provably not still waiting on tc-1.
        { kind: "text-delta", text: "that failed, trying another way\n" },
        { gate: gate.promise },
        { kind: "turn-end", reason: "completed" },
      ]),
      adapterSlug: "claude-code",
    })

    const turn = registry.sendPrompt(desc.id, "go")
    await new Promise(r => setTimeout(r, 25))
    const mid = registry.get(desc.id)
    expect(mid?.busy).toBe(true)
    expect(mid?.blockedOn).toBeUndefined()

    gate.resolve()
    await turn
    registry.shutdown()
  })

  it("non-regression: unclassified tools leave the descriptor untouched and list() JSON keeps its shape", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession([
        { kind: "tool-call", toolName: "read_file", toolCallId: "tc-1" },
        { kind: "tool-result", toolName: "read_file", toolCallId: "tc-1", result: "x" },
        { kind: "turn-end", reason: "completed" },
      ]),
      adapterSlug: "claude-code",
    })

    await registry.sendPrompt(desc.id, "go")

    const row = registry.list().find(s => s.id === desc.id)
    expect(row).toBeDefined()
    expect(row?.blockedOn).toBeUndefined()
    expect(row?.pendingToolCallId).toBeUndefined()
    // Existing shape untouched: the descriptor still serializes cleanly and
    // carries its pre-existing fields.
    const json = JSON.parse(JSON.stringify(row)) as Record<string, unknown>
    expect(json.id).toBe(desc.id)
    expect(json.status).toBeDefined()
    expect(json.kind).toBeDefined()
    expect("blockedOn" in json).toBe(false)

    registry.shutdown()
  })
})
