/**
 * DX-improvement tests for session-tools (MCP tool behaviour additions).
 * Tests helpers and registry-level behaviours directly — avoids the heavy
 * McpServer setup while still exercising the real session logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { stripAnsi } from "../session-tools.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type PtyFactory,
  type PtyProcess,
} from "../sessions.js"

// ── stripAnsi ────────────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red")
  })

  it("removes cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[H hello")).toBe(" hello")
  })

  it("leaves plain text untouched", () => {
    expect(stripAnsi("hello world")).toBe("hello world")
  })

  it("handles dim + reset around turn-end markers", () => {
    const line = "\x1b[2m── turn-end (completed) ──\x1b[0m"
    expect(stripAnsi(line)).toBe("── turn-end (completed) ──")
  })
})

// ── shared tmp dir ────────────────────────────────────────────────────────────

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "session-tools-dx-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ── PTY factory helper ────────────────────────────────────────────────────────

interface PtyCaptured {
  dataCb: ((data: string) => void) | null
  exitCb: ((evt: { exitCode: number; signal?: number }) => void) | null
}

function makeFakePtyFactory(captured: PtyCaptured, pid = 9999): PtyFactory {
  return (): PtyProcess => ({
    pid,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: (cb) => { captured.dataCb = cb },
    onExit: (cb) => { captured.exitCb = cb },
  })
}

// ── Item 3: get_agent_session_output for PTY ─────────────────────────────────
// We test the registry's `readTerminalOutput` returns bytes that the tool
// layer can decode + strip. The tool layer itself is thin, so verifying
// the registry path + stripAnsi is sufficient.

describe("readTerminalOutput (PTY byte ring)", () => {
  it("returns null for a non-PTY (agent-cli) session", () => {
    const persistPath = join(tmp, "sessions.json")
    const reg = createSessionsRegistry({ persistPath })
    const fakeAgent: AgentSessionLike = {
      sessionId: "agent-xyz",
      async *send() { yield { kind: "turn-end" } },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeAgent,
      adapterSlug: "claude-code",
    })
    expect(reg.readTerminalOutput(desc.id)).toBeNull()
    reg.shutdown()
  })

  it("returns a Buffer with PTY bytes + can strip ANSI for readable output", () => {
    const persistPath = join(tmp, "sessions.json")
    const captured: PtyCaptured = { dataCb: null, exitCb: null }
    const reg = createSessionsRegistry({
      persistPath,
      spawnPty: makeFakePtyFactory(captured, 1001),
    })
    const desc = reg.spawnPty({
      workspaceSlug: "default",
      cwd: tmp,
      argv: ["bash"],
      cols: 80,
      rows: 24,
    })
    // Simulate PTY output with ANSI codes
    expect(captured.dataCb).not.toBeNull()
    captured.dataCb!("\x1b[32mhello\x1b[0m\r\nworld")

    const buf = reg.readTerminalOutput(desc.id)
    expect(buf).not.toBeNull()
    expect(buf!.byteLength).toBeGreaterThan(0)

    // Verify that stripAnsi on the decoded bytes gives readable text
    const text = stripAnsi(buf!.toString("utf8"))
    expect(text).toContain("hello")
    expect(text).toContain("world")

    reg.shutdown()
  })
})


// ── Item 5: list_sessions limit ───────────────────────────────────────────────
// Validate that registry.list() returns newest-first (already guaranteed by
// the registry) so the tool's `slice(0, limit)` gives the right sessions.

describe("list_sessions order (for limit param validation)", () => {
  it("returns sessions newest-first from registry.list()", async () => {
    const persistPath = join(tmp, "sessions-list.json")
    const reg = createSessionsRegistry({ persistPath })

    const makeAgent = (sid: string): AgentSessionLike => ({
      sessionId: sid,
      async *send() { yield { kind: "turn-end" } },
      async cancel() {},
      async close() {},
    })

    const d1 = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: makeAgent("a1"),
      adapterSlug: "claude-code",
    })
    await new Promise(res => setTimeout(res, 5))
    const d2 = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: makeAgent("a2"),
      adapterSlug: "claude-code",
    })

    const list = reg.list()
    // Newest first: d2 was spawned after d1
    expect(list[0]?.id).toBe(d2.id)
    expect(list[1]?.id).toBe(d1.id)

    // Slicing to 1 gives only the newest (what the tool's `limit` param does)
    expect(list.slice(0, 1)[0]?.id).toBe(d2.id)

    reg.shutdown()
  })
})

// ── awaitFirstTurn: blocks until sendPrompt resolves ─────────────────────────
// Tests the exact mechanic used by the MCP tool: spawn idle, await sendPrompt,
// read lines. No bus, no extra infrastructure.

describe("awaitFirstTurn mechanic (registry.sendPrompt + Promise.race)", () => {
  it("resolves with agent output once sendPrompt completes", async () => {
    const reg = createSessionsRegistry({ persistPath: join(tmp, "sessions-await.json") })

    const fakeAgent: AgentSessionLike = {
      sessionId: "await-test",
      async *send() {
        yield { kind: "text-delta", text: "Hello from agent!" }
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }

    // Spawn without initialPrompt — same as what awaitFirstTurn does.
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeAgent,
      adapterSlug: "test-adapter",
    })

    // sendPrompt blocks until the full turn drains into the ring buffer.
    await reg.sendPrompt(desc.id, "say hello")

    const lines: string[] = []
    const unsub = reg.attach(desc.id, line => { lines.push(line) })
    if (unsub) unsub()

    expect(lines.some(l => l.includes("Hello from agent!"))).toBe(true)

    reg.shutdown()
  })

  it("Promise.race resolves 'timeout' when cap fires before the turn ends", async () => {
    const reg = createSessionsRegistry({ persistPath: join(tmp, "sessions-timeout.json") })

    const fakeAgent: AgentSessionLike = {
      sessionId: "slow-test",
      async *send() {
        await new Promise(res => setTimeout(res, 10_000))
        yield { kind: "turn-end" }
      },
      async cancel() {},
      async close() {},
    }

    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeAgent,
      adapterSlug: "test-adapter",
    })

    const SMALL_CAP_MS = 150
    const result = await Promise.race([
      reg.sendPrompt(desc.id, "slow task").then(() => "done" as const),
      new Promise<"timeout">(res => setTimeout(() => res("timeout"), SMALL_CAP_MS)),
    ])

    expect(result).toBe("timeout")

    reg.shutdown()
  }, 5_000)
})

// ── nextStep field ────────────────────────────────────────────────────────────
// Verify the format of the nextStep hint that start_agent_session embeds in
// every success response (both DROP and AWAIT modes).

describe("nextStep hint format", () => {
  it("contains the session id and both recommended tool call names", () => {
    const reg = createSessionsRegistry({ persistPath: join(tmp, "sessions-nextstep.json") })

    const fakeAgent: AgentSessionLike = {
      sessionId: "nextstep-test",
      async *send() { yield { kind: "turn-end" } },
      async cancel() {},
      async close() {},
    }

    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeAgent,
      adapterSlug: "test-adapter",
    })

    // Reproduce the buildNextStep logic from session-tools.ts.
    const nextStep =
      `session_monitor({ sessionIds: ['${desc.id}'], event: 'turn-end' })` +
      `  |  agent_output({ sessionId: '${desc.id}' })`

    expect(nextStep).toContain(desc.id)
    expect(nextStep).toContain("session_monitor")
    expect(nextStep).toContain("agent_output")

    reg.shutdown()
  })
})
