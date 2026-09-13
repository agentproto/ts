import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      assertion()
      return
    } catch {
      await new Promise(r => setTimeout(r, 5))
    }
  }
  assertion()
}

describe("computed session activity status", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-phase-test-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("tracks thinking and in-flight tool phases, de-duplicates updates, and resets on the next turn", async () => {
    const thinkingGate = deferred()
    const toolGate = deferred()
    const afterToolGate = deferred()
    const secondTurnGate = deferred()
    let turn = 0
    const agentSession: AgentSessionLike = {
      sessionId: "phase-agent",
      async *send(): AsyncGenerator<AgentStreamEvent> {
        turn += 1
        if (turn === 1) {
          yield { kind: "thought", text: "working" }
          await thinkingGate.promise
          yield { kind: "tool-call", toolName: "file_read", toolCallId: "tc-1" }
          yield {
            kind: "tool-call",
            toolName: "file_read",
            toolCallId: "tc-1",
            arguments: { path: "/tmp/a" },
            isUpdate: true,
          }
          await toolGate.promise
          yield { kind: "tool-result", toolName: "file_read", toolCallId: "tc-1", result: "ok" }
          await afterToolGate.promise
        } else {
          await secondTurnGate.promise
        }
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const registry = createSessionsRegistry({ persist: false, transcriptDir: dir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: dir,
      agentSession,
      adapterSlug: "fake",
    })

    const firstTurn = registry.sendPrompt(desc.id, "go")
    await waitFor(() => {
      expect(registry.get(desc.id)).toMatchObject({
        currentPhase: "thinking",
        toolCallsThisTurn: 0,
      })
    })

    thinkingGate.resolve()
    await waitFor(() => {
      expect(registry.get(desc.id)).toMatchObject({
        currentPhase: "tool-call:file_read",
        toolCallsThisTurn: 1,
      })
    })

    toolGate.resolve()
    await waitFor(() => {
      expect(registry.get(desc.id)).toMatchObject({
        currentPhase: "thinking",
        toolCallsThisTurn: 1,
      })
    })

    afterToolGate.resolve()
    await firstTurn
    expect(registry.get(desc.id)).toMatchObject({
      currentPhase: "idle",
      toolCallsThisTurn: 1,
    })

    const secondTurn = registry.sendPrompt(desc.id, "again")
    await waitFor(() => {
      expect(registry.get(desc.id)).toMatchObject({
        currentPhase: "thinking",
        toolCallsThisTurn: 0,
      })
    })
    secondTurnGate.resolve()
    await secondTurn
    registry.shutdown()
  })

  it("prioritizes awaiting permission over conversational input", async () => {
    const gate = deferred()
    const agentSession: AgentSessionLike = {
      sessionId: "permission-agent",
      async *send() {
        yield {
          kind: "agent-prompt",
          toolCallId: "permission-1",
          toolName: "terminal",
          text: "Allow terminal?",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        }
        await gate.promise
        yield { kind: "turn-end", reason: "completed" }
      },
      async respondPermission() {
        return true
      },
      async cancel() {},
      async close() {},
    }
    const registry = createSessionsRegistry({ persist: false, transcriptDir: dir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: dir,
      agentSession,
      adapterSlug: "fake",
      permissionHold: true,
    })

    const running = registry.sendPrompt(desc.id, "go")
    await waitFor(() => {
      expect(registry.get(desc.id)).toMatchObject({
        currentPhase: "awaiting-permission",
        toolCallsThisTurn: 0,
      })
    })
    gate.resolve()
    await running
    registry.shutdown()
  })

  it("surfaces a conversational agent prompt as awaiting input", async () => {
    const gate = deferred()
    const agentSession: AgentSessionLike = {
      sessionId: "input-agent",
      async *send() {
        yield { kind: "agent-prompt", text: "Which option?" }
        await gate.promise
        yield { kind: "turn-end", reason: "awaiting-input" }
      },
      async cancel() {},
      async close() {},
    }
    const registry = createSessionsRegistry({ persist: false, transcriptDir: dir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: dir,
      agentSession,
      adapterSlug: "fake",
    })

    const running = registry.sendPrompt(desc.id, "go")
    await waitFor(() => {
      expect(registry.get(desc.id)?.currentPhase).toBe("awaiting-input")
    })
    gate.resolve()
    await running
    expect(registry.get(desc.id)?.currentPhase).toBe("awaiting-input")
    registry.shutdown()
  })

  it("computes elapsed activity and maps terminal states", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: dir })
    const command = registry.recordCommand({
      workspaceSlug: "default",
      cwd: dir,
      command: "true",
      args: [],
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
    })
    expect(registry.get(command.id)).toMatchObject({
      currentPhase: "completed",
      toolCallsThisTurn: 0,
    })

    const agentSession: AgentSessionLike = {
      sessionId: "elapsed-agent",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: dir,
      agentSession,
      adapterSlug: "fake",
    })
    desc.lastActivityAt = new Date(Date.now() - 2_500).toISOString()
    expect(registry.list().find(row => row.id === desc.id)).toMatchObject({
      currentPhase: "idle",
      secondsSinceLastActivity: 2,
      toolCallsThisTurn: 0,
    })

    await registry.kill(desc.id)
    expect(registry.get(desc.id)?.currentPhase).toBe("killed")
    await registry.settlePendingWrites()
    registry.shutdown()
  })
})
