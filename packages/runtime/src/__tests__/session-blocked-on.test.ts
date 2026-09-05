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
import { sessionEventsPath } from "../transcript-writer.js"
import { readFileSync } from "node:fs"

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

/** Read a session's `events.jsonl` once the turn has durably landed.
 *
 *  `sendPrompt` resolving does NOT mean the transcript is on disk: the
 *  writer appends through a `fs.WriteStream` (created lazily, flushed
 *  asynchronously) and the registry closes it fire-and-forget, so a fixed
 *  sleep raced the stream open on slower CI runners and read ENOENT.
 *  Poll instead, bounded, until the file exists AND carries the terminal
 *  `turn-end` record this suite asserts on. */
async function readEventsAfterTurnEnd(
  sessionId: string,
  baseDir: string,
  timeoutMs = 2000,
): Promise<AgentStreamEvent[]> {
  const path = sessionEventsPath(sessionId, baseDir)
  const deadline = Date.now() + timeoutMs
  let last: AgentStreamEvent[] = []
  for (;;) {
    let raw = ""
    try {
      raw = readFileSync(path, "utf-8")
    } catch {
      raw = ""
    }
    last = raw
      .trim()
      .split("\n")
      .filter(line => line.length > 0)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as AgentStreamEvent]
        } catch {
          // A torn final line — the next poll sees it whole.
          return []
        }
      })
    if (last.some(event => event.kind === "turn-end")) return last
    if (Date.now() >= deadline) {
      throw new Error(
        `no turn-end record in ${path} after ${timeoutMs}ms (${last.length} records read)`,
      )
    }
    await new Promise(r => setTimeout(r, 10))
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

  it("synthesizes a tool-result for orphaned pending tool calls at turn-end", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession([
        { kind: "tool-call", toolName: "read_file", toolCallId: "tc-orphan", arguments: { path: "/tmp/x" } },
        // Stream ends here: no tool-result, no turn-end (adapter dropped it).
      ]),
      adapterSlug: "claude-code",
    })

    await registry.sendPrompt(desc.id, "go")

    // The descriptor is clean.
    expect(registry.get(desc.id)?.blockedOn).toBeUndefined()

    // The transcript carries a synthetic tool-result BEFORE the synthetic turn-end.
    const lines = await readEventsAfterTurnEnd(desc.id, transcriptDir)
    const toolResults = lines.filter(
      (r): r is AgentStreamEvent & { kind: "tool-result" } => r.kind === "tool-result"
    )
    expect(toolResults.length).toBe(1)
    expect(toolResults[0]).toMatchObject({
      kind: "tool-result",
      toolCallId: "tc-orphan",
      result: null,
      isError: false,
    })

    // Synthetic turn-end follows the synthetic tool-result.
    const turnEnds = lines.filter(r => r.kind === "turn-end")
    expect(turnEnds.length).toBe(1)
    const resultIdx = lines.findIndex(r => r.kind === "tool-result")
    const turnEndIdx = lines.findIndex(r => r.kind === "turn-end")
    expect(resultIdx).toBeLessThan(turnEndIdx)

    registry.shutdown()
  })

  it("settles each nested orphan before an adapter-supplied turn-end", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession([
        { kind: "tool-call", toolName: "View Image", toolCallId: "outer", arguments: { path: "one.png" } },
        { kind: "tool-call", toolName: "View Image", toolCallId: "inner", arguments: { path: "two.png" } },
        { kind: "tool-result", toolName: "View Image", toolCallId: "inner", result: "rendered" },
        // Hermes can finish a turn here without a completion for `outer`.
        { kind: "turn-end", reason: "completed" },
      ]),
      adapterSlug: "hermes",
    })

    await registry.sendPrompt(desc.id, "go")
    const lines = await readEventsAfterTurnEnd(desc.id, transcriptDir)
    const results = lines.filter(
      (event): event is AgentStreamEvent & { kind: "tool-result" } => event.kind === "tool-result",
    )
    expect(results).toMatchObject([
      { toolCallId: "inner", result: "rendered" },
      { toolCallId: "outer", result: null, isError: false },
    ])
    expect(results).toHaveLength(2)

    // Settlement precedes the real adapter terminal record, so any replay
    // (including a client that has not yet gained the legacy safety net) sees
    // a closed outer call before it closes the turn.
    const outerResultIndex = lines.findIndex(
      event => event.kind === "tool-result" && event.toolCallId === "outer",
    )
    const turnEndIndex = lines.findIndex(event => event.kind === "turn-end")
    expect(outerResultIndex).toBeGreaterThan(-1)
    expect(outerResultIndex).toBeLessThan(turnEndIndex)
    expect(lines.filter(event => event.kind === "turn-end")).toHaveLength(1)

    registry.shutdown()
  })
})
