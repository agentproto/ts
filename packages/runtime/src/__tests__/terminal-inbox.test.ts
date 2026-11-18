/**
 * A provider TUI launched as a PTY (`agentproto sessions terminal -- claude`)
 * must be able to RECEIVE `message_send` — not just emit it. The registry
 * parks the message in the terminal's inbox and types it into the PTY once the
 * TUI has been silent (idle at its prompt), never while it is painting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, hasVisiblePaint } from "../sessions.js"
import type { PtyFactory, SessionsRegistry } from "../sessions.js"
import { createSessionMessage } from "../session-message.js"
import type { MessageUrgency } from "../session-message.js"

const QUIET = 1_000
const POLL = 100
const SUBMIT = 50

function ptyHarness(): {
  factory: PtyFactory
  writes: string[]
  feed: (chunk: string) => void
  failEnter: { on: boolean }
} {
  const writes: string[] = []
  const failEnter = { on: false }
  const handlers: Array<(chunk: string) => void> = []
  const factory: PtyFactory = () => ({
    pid: 4242,
    write: (d: string) => {
      if (failEnter.on && d === "\r") throw new Error("pty closed")
      writes.push(d)
    },
    resize: () => {},
    kill: () => {},
    onData: (cb: (chunk: string) => void) => {
      handlers.push(cb)
    },
    onExit: () => {},
  })
  return { factory, writes, failEnter, feed: chunk => handlers.forEach(h => h(chunk)) }
}

describe("terminal sessions receive messages", () => {
  let fakeHome: string
  let registry: SessionsRegistry
  let harness: ReturnType<typeof ptyHarness>

  beforeEach(() => {
    vi.useFakeTimers()
    fakeHome = mkdtempSync(join(tmpdir(), "terminal-inbox-"))
    harness = ptyHarness()
    registry = createSessionsRegistry({
      bucketsRoot: join(fakeHome, "workspaces"),
      workspacesConfigPath: join(fakeHome, "workspaces.json"),
      transcriptDir: join(fakeHome, "sessions"),
      spawnPty: harness.factory,
      terminalInject: { quietMs: QUIET, pollMs: POLL, submitDelayMs: SUBMIT, burstMs: 400 },
      // The link probe is irrelevant here and would hit the real fs.
      conversationLinkProbeMs: { initialMs: 3_600_000, intervalMs: 3_600_000 },
    })
  })

  afterEach(async () => {
    registry.shutdown()
    vi.useRealTimers()
    // The terminal transcript writer flushes asynchronously: let it settle,
    // and retry the removal if it is still creating files under the dir.
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const spawn = (argv: string[]) =>
    registry.spawnPty({ workspaceSlug: "default", cwd: "/fake/term-inbox", argv, cols: 80, rows: 24 })

  const message = (to: string, text: string, urgency: MessageUrgency = "next-turn") =>
    createSessionMessage({
      to,
      from: { relation: "human", label: "tester" },
      text,
      kind: "report",
      urgency,
    })

  it("parks the message, then types it and presses Enter once the TUI is idle", async () => {
    const desc = spawn(["claude"])
    harness.feed("\x1b[?2004h> ready") // the TUI painted its prompt and enabled bracketed paste
    const result = await registry.sendMessage(message(desc.id, "run the migration"))
    expect(result).toMatchObject({ queued: true, delivered: null, urgencyApplied: "next-turn" })
    expect(registry.listInbox(desc.id)?.map(m => m.text)).toEqual(["run the migration"])
    expect(harness.writes).toEqual([])

    await vi.advanceTimersByTimeAsync(QUIET + POLL)
    expect(harness.writes[0]).toMatch(/^\x1b\[200~/)
    expect(harness.writes[0]).toContain("run the migration")
    expect(harness.writes[0]).toContain("<agentproto-message")
    expect(harness.writes[0]).toMatch(/\x1b\[201~$/)
    // Enter is its own write, after the submit delay.
    await vi.advanceTimersByTimeAsync(SUBMIT)
    expect(harness.writes).toHaveLength(2)
    expect(harness.writes[1]).toBe("\r")
    // Consumed: gone from the inbox, never typed twice.
    expect(registry.listInbox(desc.id)).toEqual([])
    await vi.advanceTimersByTimeAsync(10 * QUIET)
    expect(harness.writes).toHaveLength(2)
  })

  it("leaves a trace when the typed text could not be submitted", async () => {
    const desc = spawn(["claude"])
    harness.feed("> ")
    harness.failEnter.on = true
    await registry.sendMessage(message(desc.id, "lost enter"))
    await vi.advanceTimersByTimeAsync(QUIET + POLL + SUBMIT)
    expect(harness.writes.some(w => w.includes("lost enter"))).toBe(true)
    expect(harness.writes).not.toContain("\r")
    // Not re-queued (it is already in the composer), but not silent either.
    expect(registry.listInbox(desc.id)).toEqual([])
    expect(registry.readOutputTail(desc.id, 20).join("\n")).toMatch(/typed but its Enter could not be written: pty closed/)
  })

  it("never types while the TUI is still painting (mid-turn)", async () => {
    const desc = spawn(["claude"])
    harness.feed("working…")
    await registry.sendMessage(message(desc.id, "ping"))
    // A spinner repaints every 300 ms for 5 s: never quiet for QUIET ms.
    for (let i = 0; i < 16; i++) {
      await vi.advanceTimersByTimeAsync(300)
      harness.feed("\r⠙ thinking")
    }
    expect(harness.writes).toEqual([])
    expect(registry.listInbox(desc.id)).toHaveLength(1)
    // The turn ends, the TUI goes silent: now it is delivered.
    await vi.advanceTimersByTimeAsync(QUIET + POLL)
    expect(harness.writes[0]).toContain("ping")
  })

  it("treats invisible chunks (title-bar clock ticks) as idle, as Hermes emits them", async () => {
    const desc = spawn(["hermes", "--tui"])
    harness.feed("> ")
    await registry.sendMessage(message(desc.id, "hello hermes"))
    // Hermes rewrites its window title every second while idle.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(500)
      harness.feed("\x1b]2;⏳ model · ~/proj\x07\x1b[?25l")
    }
    await vi.advanceTimersByTimeAsync(QUIET + POLL)
    expect(harness.writes[0]).toContain("hello hermes")
  })

  it("ignores a once-a-second visible status-bar counter, as Hermes paints while idle", async () => {
    const desc = spawn(["hermes", "--tui"])
    harness.feed("> ")
    await registry.sendMessage(message(desc.id, "hello again"))
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(500)
      harness.feed(`\x1b[H\x1b[30B\x1b[38;5;178m${i}s\x1b[39m`) // elapsed counter: visible, isolated
    }
    expect(harness.writes[0]).toContain("hello again")
  })

  it("waits for the first paint before typing into a booting TUI", async () => {
    const desc = spawn(["claude"])
    await registry.sendMessage(message(desc.id, "early"))
    await vi.advanceTimersByTimeAsync(10 * QUIET)
    expect(harness.writes).toEqual([])
    harness.feed("> ")
    await vi.advanceTimersByTimeAsync(QUIET + POLL)
    expect(harness.writes[0]).toContain("early")
  })

  it("delivers several messages one per quiet window, oldest first", async () => {
    const desc = spawn(["claude"])
    harness.feed("> ")
    await registry.sendMessage(message(desc.id, "first"))
    await registry.sendMessage(message(desc.id, "second"))
    await vi.advanceTimersByTimeAsync(QUIET + POLL + SUBMIT)
    expect(harness.writes.filter(w => w.includes("first"))).toHaveLength(1)
    expect(harness.writes.some(w => w.includes("second"))).toBe(false)
    harness.feed("the TUI answers") // typing the first one started a turn
    await vi.advanceTimersByTimeAsync(QUIET + POLL + SUBMIT)
    expect(harness.writes.filter(w => w.includes("second"))).toHaveLength(1)
  })

  it("flattens the envelope to one line when the TUI has no bracketed paste", async () => {
    const desc = spawn(["codex"])
    harness.feed("> ")
    await registry.sendMessage(message(desc.id, "line one\nline two"))
    await vi.advanceTimersByTimeAsync(QUIET + POLL)
    expect(harness.writes[0]).not.toContain("\n")
    expect(harness.writes[0]).not.toContain("\x1b[200~")
    expect(harness.writes[0]).toContain("line one line two")
  })

  it("keeps fyi in the inbox without ever typing it", async () => {
    const desc = spawn(["claude"])
    harness.feed("> ")
    const result = await registry.sendMessage(message(desc.id, "just so you know", "fyi"))
    expect(result.delivered).toEqual({ via: "inbox" })
    await vi.advanceTimersByTimeAsync(10 * QUIET)
    expect(harness.writes).toEqual([])
    expect(registry.listInbox(desc.id)).toHaveLength(1)
  })

  it("does not type a message the TUI's owner already acked", async () => {
    const desc = spawn(["claude"])
    harness.feed("> ")
    const result = await registry.sendMessage(message(desc.id, "never mind"))
    registry.ackInbox(desc.id, [result.messageId])
    await vi.advanceTimersByTimeAsync(10 * QUIET)
    expect(harness.writes).toEqual([])
  })

  it("still refuses a plain shell: typed text would be executed there", async () => {
    const desc = spawn(["bash"])
    harness.feed("$ ")
    await expect(registry.sendMessage(message(desc.id, "rm -rf /"))).rejects.toThrow(/not an agent session/)
    await vi.advanceTimersByTimeAsync(10 * QUIET)
    expect(harness.writes).toEqual([])
  })

  it("records the access profile echo on the descriptor", () => {
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: "/fake/term-inbox",
      argv: ["claude"],
      cols: 80,
      rows: 24,
      accessProfile: { profileRef: "claude-subs-agentik", endpoint: "anthropic", method: "oauth-bearer" },
    })
    expect(desc.accessProfile?.profileRef).toBe("claude-subs-agentik")
  })
})

describe("hasVisiblePaint", () => {
  it("ignores title updates, cursor moves and colour codes", () => {
    expect(hasVisiblePaint("\x1b]1;⏳\x07\x1b]2;⏳ model · ~/ts\x07")).toBe(false)
    expect(hasVisiblePaint("\x1b[?25l\x1b[2;4H\x1b[38;5;178m\x1b[0m")).toBe(false)
    expect(hasVisiblePaint("\r\n  ")).toBe(false)
  })
  it("sees drawn text", () => {
    expect(hasVisiblePaint("\x1b[2;4H⠙ thinking")).toBe(true)
    expect(hasVisiblePaint("> ")).toBe(true)
  })
})
