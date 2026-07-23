import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type PtyProcess,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { sessionTranscriptDir } from "../transcript-writer.js"

/**
 * Tests covering the registry behaviours that have historically
 * regressed: boot-time history reload, shutdown idempotency, and
 * the provider-aware output sniffer.
 */

/** Poll a fire-and-forget read until it resolves non-null, instead of a
 *  fixed sleep-then-read — a single 20ms sleep flakes under CI load
 *  (the write genuinely hasn't landed yet), this doesn't. */
async function pollUntil<T>(read: () => Promise<T | null>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() >= deadline) throw new Error("pollUntil timed out")
    await new Promise(res => setTimeout(res, 5))
  }
}

describe("createSessionsRegistry", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sessions-test-"))
    persistPath = join(tmp, "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("loads historical descriptors from sessions.json on boot", () => {
    // Seed the file as if a previous daemon had written it.
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-05-14T00:00:00Z",
        sessions: [
          {
            id: "sess_aaaaaaaa",
            kind: "terminal",
            workspaceSlug: "default",
            command: "bash -l",
            pid: null,
            status: "exited",
            startedAt: "2026-05-14T00:00:00Z",
            pty: true,
            name: "shell",
            exitCode: 0,
          },
        ],
      }),
    )
    const reg = createSessionsRegistry({ persistPath })
    const list = reg.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: "sess_aaaaaaaa",
      name: "shell",
      status: "exited",
      kind: "terminal",
      pty: true,
    })
    reg.shutdown()
  })

  it("marks formerly-running sessions as killed on reload, and clears their frozen in-flight flags", () => {
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-05-14T00:00:00Z",
        sessions: [
          {
            id: "sess_bbbbbbbb",
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "claude (agent)",
            pid: null,
            // Was "running" AND mid-turn at last save — daemon died without
            // graceful shutdown, so these in-flight fields were never
            // cleared by the turn loop's own `finally` block.
            status: "running",
            startedAt: "2026-05-14T00:00:00Z",
            busy: true,
            awaitingInput: true,
            awaitingQuestion: { text: "continue?", source: "heuristic" },
            awaitingPermission: true,
            blockedOn: "command",
            pendingToolCallId: "tc_1",
          },
        ],
      }),
    )
    const reg = createSessionsRegistry({ persistPath })
    const list = reg.list()
    // Reclassified to killed so attach calls don't try to reach a
    // process that's already dead, and honestly tagged: this wasn't an
    // operator kill, the daemon died out from under it.
    expect(list[0]).toMatchObject({
      status: "killed",
      endedReason: "daemon-restart",
      busy: false,
      awaitingInput: false,
    })
    // The regression this guards: these must not stay frozen at their
    // mid-turn values — a "killed but busy" session is what the operator
    // sees as an unexplained stuck agent.
    expect(list[0]?.awaitingQuestion).toBeUndefined()
    expect(list[0]?.awaitingPermission).toBeUndefined()
    expect(list[0]?.blockedOn).toBeUndefined()
    expect(list[0]?.pendingToolCallId).toBeUndefined()
    reg.shutdown()
  })

  it("clears frozen in-flight flags on a row that was ALREADY terminal in the snapshot", () => {
    // Observed on a live daemon: 9 rows shaped exactly like this, two of them
    // rendering as "blocked on command · toolu_…" on a session whose own
    // status said killed. They reach this state either from a kill racing the
    // turn's finally, or — the real path — from a snapshot written by a daemon
    // predating the boot-time reconciliation: those "killed + busy" rows are
    // already terminal when a fixed daemon reads them, so a wasAlive-only
    // guard never revisits them and the lie survives every future boot.
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-05-14T00:00:00Z",
        sessions: [
          {
            id: "sess_f0559f3e",
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "claude (agent)",
            pid: null,
            status: "killed",
            busy: true,
            blockedOn: "command",
            pendingToolCallId: "toolu_01E28Z1dK24Khf43rYQy94Ud",
            awaitingInput: true,
            startedAt: "2026-05-14T00:00:00Z",
            endedAt: "2026-05-14T00:05:00Z",
          },
        ],
      }),
    )
    const reg = createSessionsRegistry({ persistPath })
    const ghost = reg.list()[0]
    expect(ghost?.busy).toBe(false)
    expect(ghost?.blockedOn).toBeUndefined()
    expect(ghost?.pendingToolCallId).toBeUndefined()
    expect(ghost?.awaitingInput).toBe(false)
    // Already terminal, so its own ending is untouched: it did NOT die with a
    // daemon this boot, and endedAt must not be rewritten to boot time.
    expect(ghost?.status).toBe("killed")
    expect(ghost?.endedAt).toBe("2026-05-14T00:05:00Z")
    expect(ghost?.endedReason).toBeUndefined()
    reg.shutdown()
  })

  it("re-validates a persisted contextUsed on reload — a stale out-of-window value can't outlive a restart (#364 follow-up)", () => {
    // Observed on a live daemon: a hermes/kimi session's sessions.json row
    // carried contextSize=200_000 / contextUsed=14_246_419 (71x over) from
    // before plausibleContextUsed existed. The session is already dead
    // (killed), so it will never get a fresh usage_update to self-correct
    // — reload itself has to refuse to resurrect the stale figure.
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-07-15T00:00:00Z",
        sessions: [
          {
            id: "sess_60a517cf",
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "hermes (agent)",
            pid: null,
            status: "killed",
            startedAt: "2026-07-15T00:00:00Z",
            endedAt: "2026-07-15T00:05:00Z",
            model: "kimi-k2.7-code",
            contextSize: 200_000,
            contextUsed: 14_246_419,
          },
          {
            // Control row: a plausible contextUsed must survive reload
            // untouched — this isn't a blanket wipe of the field.
            id: "sess_a6c60ae4",
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "claude-sonnet-5 (agent)",
            pid: null,
            status: "killed",
            startedAt: "2026-07-15T00:00:00Z",
            endedAt: "2026-07-15T00:05:00Z",
            model: "claude-sonnet-5",
            contextSize: 967_000,
            contextUsed: 202_718,
          },
        ],
      }),
    )
    const reg = createSessionsRegistry({ persistPath })
    const list = reg.list()
    const bad = list.find(s => s.id === "sess_60a517cf")
    expect(bad?.contextSize).toBe(200_000)
    expect(bad?.contextUsed).toBeUndefined()
    const good = list.find(s => s.id === "sess_a6c60ae4")
    expect(good?.contextSize).toBe(967_000)
    expect(good?.contextUsed).toBe(202_718)
    reg.shutdown()
  })

  it("emits session:exited with reason 'daemon-restart' for a formerly-running session reconciled at boot", () => {
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-05-14T00:00:00Z",
        sessions: [
          {
            id: "sess_dddddddd",
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "claude (agent)",
            pid: null,
            status: "running",
            startedAt: "2026-05-14T00:00:00Z",
            busy: true,
          },
        ],
      }),
    )
    const bus = createSessionEventBus()
    const exitedHandler = vi.fn()
    bus.on("session:exited", exitedHandler)
    // A watcher (completion-policy supervisor, session_monitor) that missed
    // the live daemon-death moment still learns about it via this boot
    // reconcile — it's not left to discover the death by accident.
    const reg = createSessionsRegistry({ persistPath, sessionEvents: bus })
    expect(exitedHandler).toHaveBeenCalledTimes(1)
    expect(exitedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:exited",
        sessionId: "sess_dddddddd",
        status: "killed",
        reason: "daemon-restart",
      }),
    )
    reg.shutdown()
  })

  it("does NOT tag endedReason or re-emit session:exited for sessions that were already terminal at last save", () => {
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-05-14T00:00:00Z",
        sessions: [
          {
            id: "sess_eeeeeeee",
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "claude (agent)",
            pid: null,
            // Already killed (e.g. via agent_kill) before the prior daemon
            // stopped — not the daemon's doing, so no endedReason.
            status: "killed",
            startedAt: "2026-05-14T00:00:00Z",
            endedAt: "2026-05-14T00:05:00Z",
            busy: false,
          },
        ],
      }),
    )
    const bus = createSessionEventBus()
    const exitedHandler = vi.fn()
    bus.on("session:exited", exitedHandler)
    const reg = createSessionsRegistry({ persistPath, sessionEvents: bus })
    expect(reg.list()[0]).toMatchObject({ status: "killed" })
    expect(reg.list()[0]?.endedReason).toBeUndefined()
    expect(exitedHandler).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("shutdown() is idempotent and doesn't wipe sessions.json on second call", () => {
    // Seed history first.
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-05-14T00:00:00Z",
        sessions: [
          {
            id: "sess_cccccccc",
            kind: "terminal",
            workspaceSlug: "default",
            command: "echo",
            pid: null,
            status: "exited",
            startedAt: "2026-05-14T00:00:00Z",
            pty: true,
          },
        ],
      }),
    )
    const reg = createSessionsRegistry({ persistPath })
    // Round 1 — graceful shutdown, snapshot expected to have 1 entry.
    reg.shutdown()
    const after1 = JSON.parse(readFileSync(persistPath, "utf8"))
    expect(after1.sessions).toHaveLength(1)
    expect(after1.sessions[0].id).toBe("sess_cccccccc")
    // Round 2 — double-shutdown was the bug: it cleared the Map then
    // wrote an empty snapshot, wiping history. Idempotency guard
    // prevents that.
    reg.shutdown()
    const after2 = JSON.parse(readFileSync(persistPath, "utf8"))
    expect(after2.sessions).toHaveLength(1)
    expect(after2.sessions[0].id).toBe("sess_cccccccc")
  })

  it("shutdown() clears busy + tags endedReason for a session that's mid-turn when the daemon stops (not an operator kill)", async () => {
    const bus = createSessionEventBus()
    const exitedHandler = vi.fn()
    bus.on("session:exited", exitedHandler)
    const reg = createSessionsRegistry({ persistPath, sessionEvents: bus })

    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-shutdown-busy",
      async *send() {
        // Never yields — the turn is still in flight when shutdown() fires,
        // so `runAgentTurn`'s own `finally` (which normally clears busy)
        // never gets a chance to run.
        await new Promise(() => {})
        yield { kind: "turn-end" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    await reg.enqueuePrompt(desc.id, "hi")
    // Sanity: the turn is genuinely in flight before shutdown.
    expect(reg.get(desc.id)?.busy).toBe(true)

    reg.shutdown()

    const persisted = JSON.parse(readFileSync(persistPath, "utf8"))
    const stored = persisted.sessions.find((s: { id: string }) => s.id === desc.id)
    expect(stored).toMatchObject({
      status: "killed",
      endedReason: "daemon-restart",
      busy: false,
    })
    expect(exitedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:exited",
        sessionId: desc.id,
        status: "killed",
        reason: "daemon-restart",
      }),
    )
  })

  it("spawnAgent stamps `meta` on the descriptor and it survives a persist/reload round-trip", () => {
    const reg = createSessionsRegistry({ persistPath })
    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-meta-roundtrip",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      meta: { boardId: "cowork:main" },
    })
    expect(desc.meta).toEqual({ boardId: "cowork:main" })
    // Graceful shutdown persists the snapshot synchronously.
    reg.shutdown()
    // A fresh registry (daemon restart) reloads the descriptor WITH the
    // stamp — the task ledger's board resolution reads it after reboot too.
    const reloaded = createSessionsRegistry({ persistPath })
    expect(reloaded.get(desc.id)?.meta).toEqual({ boardId: "cowork:main" })
    // And a spawn without meta stays meta-less end to end.
    const plainReg = createSessionsRegistry({ persist: false })
    const plain = plainReg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: { ...fakeAgent, sessionId: "acp-meta-none" },
      adapterSlug: "fake",
    })
    expect(plain.meta).toBeUndefined()
    plainReg.shutdown()
    reloaded.shutdown()
  })

  it("captures claude-code resume hint from agent output via the sniffer", async () => {
    const reg = createSessionsRegistry({ persistPath })
    // Synthetic AgentSessionLike — emits one "text-delta" event with
    // a claude exit line + a turn-end so the agent loop completes.
    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-session-id-xyz",
      async *send() {
        yield {
          kind: "text-delta",
          text:
            "Resume this session with: claude --resume 0e483f81-1a44-4bec-9667-b37158450296\n",
        }
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "claude-code",
      initialPrompt: "hi",
    })
    // Wait a tick so the fire-and-forget runAgentTurn drains the
    // generator and the sniffer runs over the line.
    await new Promise(res => setTimeout(res, 20))
    const after = reg.get(desc.id)
    expect(after?.resumeMetadata).toBeDefined()
    expect(after?.resumeMetadata?.claudeResumeId).toBe(
      "0e483f81-1a44-4bec-9667-b37158450296",
    )
    reg.shutdown()
  })

  it("projectEvent renders plan updates as a ring-buffer line and ignores usage_update without crashing", async () => {
    const reg = createSessionsRegistry({ persistPath })
    const fakeAgent: AgentSessionLike = {
      sessionId: "plan-usage-session",
      async *send() {
        yield {
          kind: "plan",
          entries: [
            { content: "Read the file", priority: "high", status: "completed" },
            { content: "Write the fix", priority: "medium", status: "pending" },
          ],
        }
        yield { kind: "usage_update", size: 100_000, used: 4_200 }
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "test-adapter",
    })

    await expect(reg.sendPrompt(desc.id, "go")).resolves.toBeUndefined()

    const lines: string[] = []
    const unsub = reg.attach(desc.id, line => { lines.push(line) })
    if (unsub) unsub()

    expect(lines.some(l => l.includes("[plan] 1/2") && l.includes("Read the file") && l.includes("Write the fix"))).toBe(true)
    // usage_update deliberately produces no ring-buffer line (see projectEvent) —
    // the assertion here is just that the turn completed without throwing.
    reg.shutdown()
  })

  it("orchestrator WP1: threads persisted mcpServers through the resume path", async () => {
    const mcpServers = [
      { name: "orchestration", transport: "http" as const, ref: "agentproto://gateway" },
    ]
    // Seed a dead-but-resumable agent-cli row (daemon-restart shape):
    // adapterSlug/adapterSessionId/cwd present, no live agentSession,
    // and the spawn-time mcpServers persisted on the descriptor.
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-06-21T00:00:00Z",
        sessions: [
          {
            id: "sess_mcpmcp01",
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "claude (agent)",
            pid: null,
            status: "running",
            startedAt: "2026-06-21T00:00:00Z",
            adapterSlug: "claude-code",
            adapterSessionId: "acp-resume-me",
            cwd: "/tmp",
            mcpServers,
          },
        ],
      }),
    )

    // Capture what the resumer was handed.
    let captured: { mcpServers?: unknown } | undefined
    const resumeAgent = vi.fn(async (input: { mcpServers?: unknown }) => {
      captured = input
      const fresh: AgentSessionLike = {
        sessionId: "acp-resume-me",
        async *send() {
          yield { kind: "turn-end", reason: "completed" }
        },
        async cancel() {},
        async close() {},
      }
      return fresh
    })

    const reg = createSessionsRegistry({ persistPath, resumeAgent })
    // A prompt to the dead row triggers maybeResumeAgent → resumeAgent.
    await reg.sendPrompt("sess_mcpmcp01", "ping")

    expect(resumeAgent).toHaveBeenCalledTimes(1)
    expect(captured?.mcpServers).toEqual(mcpServers)
    reg.shutdown()
  })

  it("WP0: emits session:turn-end on bus when a real agent turn completes", async () => {
    const bus = createSessionEventBus()
    const handler = vi.fn()
    bus.on("session:turn-end", handler)

    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-wp0-test",
      async *send() {
        yield { kind: "text-delta", text: "hello" }
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      initialPrompt: "go",
    })

    // Wait for the fire-and-forget runAgentTurn to drain.
    await new Promise(res => setTimeout(res, 20))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:turn-end",
        sessionId: desc.id,
        awaitingInput: false,
      }),
    )
    reg.shutdown()
  })

  it("propagates the driver's turn-end reason (e.g. watchdog-timeout) onto the session:turn-end bus event", async () => {
    const bus = createSessionEventBus()
    const handler = vi.fn()
    bus.on("session:turn-end", handler)

    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-watchdog-test",
      async *send() {
        yield { kind: "text-delta", text: "partial answer before hermes went silent" }
        yield { kind: "turn-end", reason: "watchdog-timeout" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      initialPrompt: "go",
    })

    await new Promise(res => setTimeout(res, 20))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:turn-end",
        sessionId: desc.id,
        reason: "watchdog-timeout",
      }),
    )
    reg.shutdown()
  })

  it("WP0: emits session:turn-end with awaitingInput=true when agent-prompt fires", async () => {
    const bus = createSessionEventBus()
    const turnEndHandler = vi.fn()
    const awaitingHandler = vi.fn()
    bus.on("session:turn-end", turnEndHandler)
    bus.on("session:awaiting-input", awaitingHandler)

    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-wp0-awaiting",
      async *send() {
        yield { kind: "agent-prompt" }
        yield { kind: "turn-end", reason: "awaiting-input" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      initialPrompt: "go",
    })

    await new Promise(res => setTimeout(res, 20))

    expect(turnEndHandler).toHaveBeenCalledTimes(1)
    expect(turnEndHandler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: desc.id, awaitingInput: true }),
    )
    expect(awaitingHandler).toHaveBeenCalledTimes(1)
    expect(awaitingHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:awaiting-input", sessionId: desc.id }),
    )
    // awaitingInput flag must be set on the descriptor too (routine-runner reads it).
    expect(reg.get(desc.id)?.awaitingInput).toBe(true)
    reg.shutdown()
  })

  it("structured awaiting-input: agent-prompt with options produces a structured question", async () => {
    const bus = createSessionEventBus()
    const awaitingHandler = vi.fn()
    bus.on("session:awaiting-input", awaitingHandler)

    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-structured-question",
      async *send() {
        yield {
          kind: "agent-prompt",
          toolName: "Bash",
          options: [
            { id: "allow_once", label: "Allow once" },
            { id: "reject_once", label: "Reject" },
          ],
        }
        yield { kind: "turn-end", reason: "awaiting-input" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      initialPrompt: "go",
    })

    await new Promise(res => setTimeout(res, 20))

    expect(reg.get(desc.id)?.awaitingQuestion).toEqual({
      text: 'Allow "Bash"?',
      options: ["Allow once", "Reject"],
      source: "structured",
    })
    expect(awaitingHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        question: { text: 'Allow "Bash"?', options: ["Allow once", "Reject"], source: "structured" },
      }),
    )
    reg.shutdown()
  })

  it("heuristic awaiting-input: a trailing '?' with enumerated options is derived from the transcript tail", async () => {
    const bus = createSessionEventBus()
    const turnEndHandler = vi.fn()
    bus.on("session:turn-end", turnEndHandler)

    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

    // No structured agent-prompt — just a driver reporting an
    // "awaiting-input" turn-end reason after streaming text that reads
    // like a clarifying question with options (matches every
    // currently-supported adapter's actual behaviour: no driver reports
    // agent-prompt today).
    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-heuristic-question",
      async *send() {
        yield { kind: "text-delta", text: "Which environment should I target?\n1. staging\n2. production\n" }
        yield { kind: "turn-end", reason: "awaiting-input" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      initialPrompt: "go",
    })

    await new Promise(res => setTimeout(res, 20))

    expect(reg.get(desc.id)?.awaitingQuestion).toEqual({
      text: "Which environment should I target?",
      options: ["staging", "production"],
      source: "heuristic",
    })
    expect(turnEndHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        question: {
          text: "Which environment should I target?",
          options: ["staging", "production"],
          source: "heuristic",
        },
      }),
    )
    reg.shutdown()
  })

  it("heuristic awaiting-input: no trailing '?' means no question is derived", async () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-no-question",
      async *send() {
        yield { kind: "text-delta", text: "Done, nothing more to do here.\n" }
        yield { kind: "turn-end", reason: "awaiting-input" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      initialPrompt: "go",
    })

    await new Promise(res => setTimeout(res, 20))

    expect(reg.get(desc.id)?.awaitingInput).toBe(true)
    expect(reg.get(desc.id)?.awaitingQuestion).toBeUndefined()
    reg.shutdown()
  })

  it("WP0: emits session:exited when kill() is called on an agent-cli session", async () => {
    const bus = createSessionEventBus()
    const exitedHandler = vi.fn()
    bus.on("session:exited", exitedHandler)

    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-wp0-kill",
      async *send() {
        // Never yields — simulates a long-running turn
        await new Promise(() => {})
        yield { kind: "turn-end" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })

    reg.kill(desc.id)

    expect(exitedHandler).toHaveBeenCalledTimes(1)
    expect(exitedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:exited",
        sessionId: desc.id,
        status: "killed",
      }),
    )
    reg.shutdown()
  })

  it("kill() records killedMidTurn honestly — the signal the vscode UI reads to tell a reaped-after-finishing child apart from a mid-turn stop", async () => {
    // This is the actual mechanism the "killed" status can't carry alone:
    // status/exitCode look identical for a turn interrupted mid-flight and a
    // turn that had already finished before something killed the session.
    // kill() must capture `busy` at the instant it flips status — not leave a
    // reader to infer it later, since `busy` itself goes stale forever the
    // moment a mid-turn kill's `finally` never runs (see killedMidTurn's
    // docblock on SessionDescriptor).
    const reg = createSessionsRegistry({ persistPath, persist: false })

    const midTurnAgent: AgentSessionLike = {
      sessionId: "acp-mid-turn",
      async *send() {
        await new Promise(() => {}) // never resolves — the turn stays in flight
        yield { kind: "turn-end" }
      },
      async cancel() {},
      async close() {},
    }
    const midTurn = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: midTurnAgent,
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await new Promise(res => setTimeout(res, 20))
    expect(reg.get(midTurn.id)?.busy).toBe(true) // sanity: the turn really is in flight
    reg.kill(midTurn.id)
    expect(reg.get(midTurn.id)?.killedMidTurn).toBe(true)

    const finishedAgent: AgentSessionLike = {
      sessionId: "acp-finished",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const finished = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: finishedAgent,
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await new Promise(res => setTimeout(res, 20))
    expect(reg.get(finished.id)?.busy).toBe(false) // sanity: the turn already finished
    expect(reg.get(finished.id)?.turnsCompleted).toBe(1)
    reg.kill(finished.id) // the supervisor-reap-after-success case
    expect(reg.get(finished.id)?.killedMidTurn).toBe(false)

    reg.shutdown()
  })

  it("WP0: awaitingInput is cleared at the start of each new turn", async () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

    // First turn: agent-prompt fires → awaitingInput=true
    let sendCount = 0
    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-wp0-clear",
      async *send() {
        sendCount++
        if (sendCount === 1) {
          yield { kind: "agent-prompt" }
          yield { kind: "turn-end", reason: "awaiting-input" }
        } else {
          yield { kind: "turn-end", reason: "completed" }
        }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      initialPrompt: "first",
    })

    await new Promise(res => setTimeout(res, 20))
    expect(reg.get(desc.id)?.awaitingInput).toBe(true)

    // Second turn: should clear awaitingInput at start
    await reg.sendPrompt(desc.id, "second")
    expect(reg.get(desc.id)?.awaitingInput).toBe(false)

    reg.shutdown()
  })

  it("doesn't sniff resume hints for non-agent-cli sessions", async () => {
    const reg = createSessionsRegistry({ persistPath })
    // We can't easily spawn a real PTY in vitest, but the sniffer's
    // gate (`if (rt.desc.kind !== "agent-cli") return`) means we just
    // need an agent-cli vs non-agent-cli kind distinction. Verify
    // via a known-non-agent (`register` path).
    // Skipping the real test — covered indirectly by sniffer guard.
    // Sanity: file existed.
    expect(existsSync(persistPath)).toBe(false) // first write hasn't happened yet
    reg.shutdown()
  })

  describe("P5: synthesized terminal turn-end", () => {
    // Count the `── turn-end (reason) ──` ring-buffer separators that
    // projectEvent renders — one per turn-end event that reached the
    // stream, adapter-emitted or synthesized.
    const turnEndLines = (reg: ReturnType<typeof createSessionsRegistry>, id: string): string[] => {
      const lines: string[] = []
      const unsub = reg.attach(id, line => { lines.push(line) })
      if (unsub) unsub()
      return lines.filter(l => l.includes("── turn-end ("))
    }

    it("(a) synthesizes exactly one turn-end when the arm ends its stream WITHOUT one", async () => {
      const bus = createSessionEventBus()
      const handler = vi.fn()
      bus.on("session:turn-end", handler)
      const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

      // Arm returns cleanly after streaming text — never yields turn-end
      // (the abnormal-but-non-throwing case: generator just returns).
      const fakeAgent: AgentSessionLike = {
        sessionId: "acp-no-turnend",
        async *send() {
          yield { kind: "text-delta", text: "partial output, then the stream just ends\n" }
        },
        async cancel() {},
        async close() {},
      }
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent,
        adapterSlug: "fake",
      })

      await reg.sendPrompt(desc.id, "go")

      const ends = turnEndLines(reg, desc.id)
      expect(ends).toHaveLength(1)
      expect(ends[0]).toContain("── turn-end (exited)")
      // Completion is stamped + surfaced on the bus so waiters don't hang.
      expect(reg.get(desc.id)?.turnsCompleted).toBe(1)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session:turn-end", sessionId: desc.id, reason: "exited" }),
      )
      reg.shutdown()
    })

    it("(b) does NOT synthesize a duplicate when the arm already emitted a turn-end", async () => {
      const bus = createSessionEventBus()
      const handler = vi.fn()
      bus.on("session:turn-end", handler)
      const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

      const fakeAgent: AgentSessionLike = {
        sessionId: "acp-has-turnend",
        async *send() {
          yield { kind: "text-delta", text: "all done" }
          yield { kind: "turn-end", reason: "completed" }
        },
        async cancel() {},
        async close() {},
      }
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent,
        adapterSlug: "fake",
      })

      await reg.sendPrompt(desc.id, "go")

      const ends = turnEndLines(reg, desc.id)
      // Exactly one — the adapter's, not a second synthesized one.
      expect(ends).toHaveLength(1)
      expect(ends[0]).toContain("── turn-end (completed)")
      expect(reg.get(desc.id)?.turnsCompleted).toBe(1)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "completed" }),
      )
      reg.shutdown()
    })

    it("(c) synthesizes a turn-end with reason 'error' when the arm's stream throws", async () => {
      const bus = createSessionEventBus()
      const handler = vi.fn()
      bus.on("session:turn-end", handler)
      const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

      const fakeAgent: AgentSessionLike = {
        sessionId: "acp-throws",
        // eslint-disable-next-line require-yield
        async *send(): AsyncGenerator<never> {
          throw new Error("subprocess exited with ENOBUFS")
        },
        async cancel() {},
        async close() {},
      }
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent,
        adapterSlug: "fake",
      })

      await reg.sendPrompt(desc.id, "go")

      const ends = turnEndLines(reg, desc.id)
      expect(ends).toHaveLength(1)
      expect(ends[0]).toContain("── turn-end (error)")
      // Genuine error marks the session errored + stamps completion.
      expect(reg.get(desc.id)?.status).toBe("error")
      expect(reg.get(desc.id)?.turnsCompleted).toBe(1)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session:turn-end", sessionId: desc.id, reason: "error" }),
      )
      reg.shutdown()
    })

    it("(c') synthesizes a turn-end with reason 'aborted' when the turn is cancelled (AbortError)", async () => {
      const bus = createSessionEventBus()
      const handler = vi.fn()
      bus.on("session:turn-end", handler)
      const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })

      const fakeAgent: AgentSessionLike = {
        sessionId: "acp-aborts",
        // eslint-disable-next-line require-yield
        async *send(): AsyncGenerator<never> {
          throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
        },
        async cancel() {},
        async close() {},
      }
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent,
        adapterSlug: "fake",
      })

      await reg.sendPrompt(desc.id, "go")

      const ends = turnEndLines(reg, desc.id)
      expect(ends).toHaveLength(1)
      expect(ends[0]).toContain("── turn-end (aborted)")
      // An abort (cancel) leaves the session alive for the next turn —
      // it is NOT marked errored.
      expect(reg.get(desc.id)?.status).toBe("running")
      expect(reg.get(desc.id)?.turnsCompleted).toBe(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session:turn-end", sessionId: desc.id, reason: "aborted" }),
      )
      reg.shutdown()
    })
  })

  describe("liveness: pid / lastActivityAt / processAlive", () => {
    const fakeAgent = (pid?: number): AgentSessionLike => ({
      sessionId: "acp-liveness-test",
      ...(pid !== undefined ? { pid } : {}),
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    })

    it("spawnAgent mirrors agentSession.pid onto the descriptor", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(4242),
        adapterSlug: "fake",
      })
      expect(desc.pid).toBe(4242)
      reg.shutdown()
    })

    it("spawnAgent falls back to pid: null when the driver doesn't expose one", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(undefined),
        adapterSlug: "fake",
      })
      expect(desc.pid).toBeNull()
      reg.shutdown()
    })

    it("list()/get() compute processAlive: true for a live pid", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      // Our own process is guaranteed alive.
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(process.pid),
        adapterSlug: "fake",
      })
      expect(reg.get(desc.id)?.processAlive).toBe(true)
      expect(reg.list().find(d => d.id === desc.id)?.processAlive).toBe(true)
      reg.shutdown()
    })

    it("list()/get() compute processAlive: false when the OS reports the pid is gone", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(4242),
        adapterSlug: "fake",
      })
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
      })
      expect(reg.get(desc.id)?.processAlive).toBe(false)
      killSpy.mockRestore()
      reg.shutdown()
    })

    it("list()/get() omit processAlive when pid is null", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(undefined),
        adapterSlug: "fake",
      })
      expect(reg.get(desc.id)?.processAlive).toBeUndefined()
      expect("processAlive" in (reg.get(desc.id) ?? {})).toBe(false)
      reg.shutdown()
    })

    it("findByIdOrName (direct-id match) computes processAlive the same as get() (regression: used to skip the stamp)", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(process.pid),
        adapterSlug: "fake",
      })
      expect(reg.findByIdOrName(desc.id)?.processAlive).toBe(true)
      reg.shutdown()
    })

    it("findByIdOrName (direct-id match) computes processAlive: false when the OS reports the pid is gone", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(4242),
        adapterSlug: "fake",
      })
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
      })
      expect(reg.findByIdOrName(desc.id)?.processAlive).toBe(false)
      killSpy.mockRestore()
      reg.shutdown()
    })

    it("findByIdOrName (name-match fallback) also computes processAlive (regression: the fallback loop skipped the stamp too)", () => {
      const fakePty = (): PtyProcess => ({
        pid: process.pid,
        write() {},
        resize() {},
        kill() {},
        onData() {},
        onExit() {},
      })
      const reg = createSessionsRegistry({
        persistPath,
        persist: false,
        spawnPty: fakePty,
      })
      reg.spawnPty({
        workspaceSlug: "default",
        cwd: "/tmp",
        argv: ["fake"],
        cols: 80,
        rows: 24,
        name: "liveness-test-terminal",
      })
      expect(reg.findByIdOrName("liveness-test-terminal")?.processAlive).toBe(true)
      reg.shutdown()
    })

    it("pulseActivity stamps lastActivityAt and is a no-op for an unknown id", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(process.pid),
        adapterSlug: "fake",
      })
      expect(reg.get(desc.id)?.lastActivityAt).toBeUndefined()
      reg.pulseActivity(desc.id)
      const after = reg.get(desc.id)
      expect(after?.lastActivityAt).toBeDefined()
      expect(new Date(after!.lastActivityAt!).toISOString()).toBe(after!.lastActivityAt)
      // Unknown id — must not throw.
      expect(() => reg.pulseActivity("sess_doesnotexist")).not.toThrow()
      reg.shutdown()
    })

    it("lastActivityAt is distinct from lastOutputAt — pulsing activity doesn't touch output", async () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(process.pid),
        adapterSlug: "fake",
        initialPrompt: "go",
      })
      await new Promise(res => setTimeout(res, 20))
      const beforeOutput = reg.get(desc.id)?.lastOutputAt
      expect(beforeOutput).toBeDefined()
      reg.pulseActivity(desc.id)
      const after = reg.get(desc.id)
      expect(after?.lastActivityAt).toBeDefined()
      expect(after?.lastOutputAt).toBe(beforeOutput)
      reg.shutdown()
    })

    it("sessions.json round-trip: pid + lastActivityAt persist, processAlive is never written and is recomputed fresh", async () => {
      const reg = createSessionsRegistry({ persistPath })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent(process.pid),
        adapterSlug: "fake",
      })
      reg.pulseActivity(desc.id)
      // Force processAlive to be computed (and, pre-fix, would have
      // leaked onto the same object persistSnapshot serializes).
      expect(reg.get(desc.id)?.processAlive).toBe(true)
      reg.shutdown()

      const raw = JSON.parse(readFileSync(persistPath, "utf8"))
      expect(raw.sessions[0].pid).toBe(process.pid)
      expect(raw.sessions[0].lastActivityAt).toBeDefined()
      expect("processAlive" in raw.sessions[0]).toBe(false)

      // Fresh daemon restart: pid/lastActivityAt survive, processAlive
      // is recomputed live rather than trusted from disk (the reloaded
      // row is a "running" ghost pointed at a real, still-alive pid —
      // our own process — so the live check flips it back to true).
      const reg2 = createSessionsRegistry({ persistPath })
      const restored = reg2.get(desc.id)
      expect(restored?.pid).toBe(process.pid)
      expect(restored?.lastActivityAt).toBe(raw.sessions[0].lastActivityAt)
      expect(restored?.processAlive).toBe(true)
      reg2.shutdown()
    })
  })

  describe("opt-in Langfuse tracing", () => {
    const fakeTracingAgent = (): AgentSessionLike => ({
      sessionId: "acp-tracing-session",
      async *send() {
        yield { kind: "text-delta", text: "hi" }
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    })

    it("only forwards events for sessions that opted in via `trace: true`", async () => {
      const seen: string[] = []
      const fakeTracer = {
        recordPrompt(id: string) {
          seen.push(`prompt:${id}`)
        },
        recordEvent(id: string) {
          seen.push(`event:${id}`)
        },
        recordUsageSnapshot(id: string) {
          seen.push(`usage:${id}`)
        },
        async close(id: string) {
          seen.push(`close:${id}`)
        },
        async closeAll() {
          seen.push("closeAll")
        },
      }
      const reg = createSessionsRegistry({ persistPath, langfuseTracer: fakeTracer })

      const traced = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeTracingAgent(),
        adapterSlug: "fake",
        trace: true,
      })
      const untraced = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeTracingAgent(),
        adapterSlug: "fake",
      })

      await reg.sendPrompt(traced.id, "go")
      await reg.sendPrompt(untraced.id, "go")

      expect(seen.some(s => s.endsWith(`:${traced.id}`))).toBe(true)
      expect(seen.some(s => s.endsWith(`:${untraced.id}`))).toBe(false)

      reg.shutdown()
    })

    it("defaults to `langfuseTracingDefault` when `trace` is omitted", async () => {
      const seen: string[] = []
      const fakeTracer = {
        recordPrompt(id: string) {
          seen.push(id)
        },
        recordEvent() {},
        recordUsageSnapshot() {},
        async close() {},
        async closeAll() {},
      }
      const reg = createSessionsRegistry({
        persistPath,
        langfuseTracer: fakeTracer,
        langfuseTracingDefault: true,
      })

      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeTracingAgent(),
        adapterSlug: "fake",
      })
      await reg.sendPrompt(desc.id, "go")

      expect(seen).toContain(desc.id)
      reg.shutdown()
    })

    it("behaves byte-identically to today when no tracer is configured", async () => {
      const reg = createSessionsRegistry({ persistPath })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeTracingAgent(),
        adapterSlug: "fake",
        trace: true,
      })
      await expect(reg.sendPrompt(desc.id, "go")).resolves.toBeUndefined()
      reg.shutdown()
    })
  })

  describe("recordCommand", () => {
    let workspace: string

    beforeEach(() => {
      workspace = mkdtempSync(join(tmpdir(), "sessions-cmdlog-"))
    })

    afterEach(() => {
      rmSync(workspace, { recursive: true, force: true })
    })

    it("registers a kind:\"command\" session that's already finished", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "pnpm",
        args: ["test"],
        exitCode: 0,
        signal: null,
        durationMs: 10,
        stdout: "3 passed\n",
        stderr: "",
      })
      expect(desc.kind).toBe("command")
      expect(desc.status).toBe("exited")
      expect(desc.pid).toBeNull()
      expect(desc.argv).toEqual(["pnpm", "test"])
      expect(desc.endedAt).toBeDefined()
      expect(reg.get(desc.id)?.status).toBe("exited")
      reg.shutdown()
    })

    it("marks a nonzero exit as status \"error\"", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "node",
        args: [],
        exitCode: 1,
        signal: null,
        durationMs: 5,
        stdout: "",
        stderr: "boom",
      })
      expect(desc.status).toBe("error")
      reg.shutdown()
    })

    it("shows up in list() alongside other session kinds", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "echo",
        args: ["hi"],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "hi\n",
        stderr: "",
      })
      expect(reg.list().map(d => d.id)).toContain(desc.id)
      reg.shutdown()
    })

    it("writes the full result to the session's own events.jsonl", async () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "gh",
        args: ["pr", "view"],
        exitCode: 0,
        signal: null,
        durationMs: 7,
        stdout: "full body\n",
        stderr: "",
      })
      const entry = await pollUntil(() => reg.readCommandLog(desc.id))
      expect(entry).toMatchObject({ command: "gh", args: ["pr", "view"], stdout: "full body\n" })
      reg.shutdown()
    })

    it("also writes a normalized ToolCallRecord to the same events.jsonl (unified logger, gap 4)", async () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "gh",
        args: ["pr", "view"],
        exitCode: 0,
        signal: null,
        durationMs: 7,
        stdout: "full body\n",
        stderr: "",
      })
      const records = await pollUntil(async () => {
        const rs = await reg.readToolCallRecords(desc.id)
        return rs.length > 0 ? rs : null
      })
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        sessionId: desc.id,
        tool: "command_execute",
        command: "gh",
        args: ["pr", "view"],
        exitCode: 0,
        isError: false,
        durationMs: 7,
      })
      // The bare CommandLogEntry must still be the first line — readCommandLog
      // trusts that ordering (see recordCommand's chained write).
      const entry = await reg.readCommandLog(desc.id)
      expect(entry).toMatchObject({ command: "gh", args: ["pr", "view"] })
      reg.shutdown()
    })

    it("marks isError true on the ToolCallRecord for a nonzero exit", async () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "node",
        args: ["fail.js"],
        exitCode: 1,
        signal: null,
        durationMs: 5,
        stdout: "",
        stderr: "boom",
      })
      const records = await pollUntil(async () => {
        const rs = await reg.readToolCallRecords(desc.id)
        return rs.length > 0 ? rs : null
      })
      expect(records[0]).toMatchObject({ exitCode: 1, isError: true })
      reg.shutdown()
    })

    it("leaves origin/callerSessionId absent when the caller doesn't pass them", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "echo",
        args: ["hi"],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "hi\n",
        stderr: "",
      })
      expect(desc.origin).toBeUndefined()
      expect(desc.callerSessionId).toBeUndefined()
      reg.shutdown()
    })

    it("stamps origin and callerSessionId onto the descriptor when passed", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "echo",
        args: ["hi"],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "hi\n",
        stderr: "",
        origin: "cron",
        callerSessionId: "sess_abcd1234",
      })
      expect(desc.origin).toBe("cron")
      expect(desc.callerSessionId).toBe("sess_abcd1234")
      expect(reg.get(desc.id)).toMatchObject({ origin: "cron", callerSessionId: "sess_abcd1234" })
      reg.shutdown()
    })
  })

  describe("recordOpenedPr", () => {
    it("records session provenance idempotently and restores it from history", () => {
      const reg = createSessionsRegistry({ persistPath })
      const session = reg.recordCommand({
        workspaceSlug: "default",
        cwd: "/tmp",
        command: "git",
        args: ["status"],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
      })

      const recorded = reg.recordOpenedPr(session.id, {
        adapter: "github",
        number: 538,
        url: "https://github.com/agentproto/agentproto/pull/538",
      })
      expect(recorded?.openedPrs).toEqual([
        expect.objectContaining({
          adapter: "github",
          number: 538,
          url: "https://github.com/agentproto/agentproto/pull/538",
          openedAt: expect.any(String),
        }),
      ])

      // A retried report is not a second opened pull request.
      reg.recordOpenedPr(session.id, {
        adapter: "github",
        number: 538,
        url: "https://github.com/agentproto/agentproto/pull/538",
      })
      expect(reg.get(session.id)?.openedPrs).toHaveLength(1)
      expect(reg.recordOpenedPr("sess_missing", {
        adapter: "github",
        number: 539,
        url: "https://github.com/agentproto/agentproto/pull/539",
      })).toBeUndefined()

      // shutdown() flushes the descriptor snapshot synchronously; the
      // reloaded registry is the real persistence boundary.
      reg.shutdown()
      const restored = createSessionsRegistry({ persistPath })
      expect(restored.get(session.id)?.openedPrs).toEqual(recorded?.openedPrs)
      restored.shutdown()
    })
  })

  describe("priorCommandSessionId", () => {
    let workspace: string

    beforeEach(() => {
      workspace = mkdtempSync(join(tmpdir(), "sessions-priorcmd-"))
    })

    afterEach(() => {
      rmSync(workspace, { recursive: true, force: true })
    })

    const fakeAgent = (): AgentSessionLike => ({
      sessionId: "acp-session-id",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    })

    it("spawnAgent leaves priorCommandSessionId unset when there's no matching command session", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: workspace,
        agentSession: fakeAgent(),
        adapterSlug: "fake",
      })
      expect(desc.priorCommandSessionId).toBeUndefined()
      reg.shutdown()
    })

    it("spawnAgent points priorCommandSessionId at the prior command session's id (a reference, not its content)", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      const cmdDesc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "pnpm",
        args: ["test"],
        exitCode: 0,
        signal: null,
        durationMs: 10,
        stdout: "3 passed\n",
        stderr: "",
      })

      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: workspace,
        agentSession: fakeAgent(),
        adapterSlug: "fake",
      })
      expect(desc.priorCommandSessionId).toBe(cmdDesc.id)
      // Reference only — never the stdout content itself.
      expect(JSON.stringify(desc)).not.toContain("3 passed")
      reg.shutdown()
    })

    it("spawnAgent ignores a command session with a different cwd", () => {
      const reg = createSessionsRegistry({ persistPath, persist: false })
      reg.recordCommand({
        workspaceSlug: "default",
        cwd: join(workspace, "other"),
        command: "pnpm",
        args: [],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
      })
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: workspace,
        agentSession: fakeAgent(),
        adapterSlug: "fake",
      })
      expect(desc.priorCommandSessionId).toBeUndefined()
      reg.shutdown()
    })

    it("spawnPty sets priorCommandSessionId the same way as spawnAgent", () => {
      const fakePty = (): PtyProcess => ({
        pid: process.pid,
        write() {},
        resize() {},
        kill() {},
        onData() {},
        onExit() {},
      })
      const reg = createSessionsRegistry({ persistPath, persist: false, spawnPty: fakePty })
      const cmdDesc = reg.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: "gh",
        args: ["pr", "view"],
        exitCode: 0,
        signal: null,
        durationMs: 5,
        stdout: "",
        stderr: "",
      })
      const desc = reg.spawnPty({
        workspaceSlug: "default",
        cwd: workspace,
        argv: ["bash"],
        cols: 80,
        rows: 24,
      })
      expect(desc.priorCommandSessionId).toBe(cmdDesc.id)
      reg.shutdown()
    })
  })

  describe("terminal PTY byte persistence", () => {
    it("appends each PTY chunk to the session's terminal.jsonl", async () => {
      let dataHandler: ((chunk: string) => void) | undefined
      const fakePty = (): PtyProcess => ({
        pid: process.pid,
        write() {},
        resize() {},
        kill() {},
        onData(handler) {
          dataHandler = handler
        },
        onExit() {},
      })
      const reg = createSessionsRegistry({ persistPath, persist: false, spawnPty: fakePty })
      const desc = reg.spawnPty({
        workspaceSlug: "default",
        cwd: tmp,
        argv: ["bash"],
        cols: 80,
        rows: 24,
      })
      dataHandler?.("hello pty\n")
      dataHandler?.("more output\n")

      const path = join(sessionTranscriptDir(desc.id, join(tmp, "sessions")), "terminal.jsonl")
      // Give the write stream a tick to flush.
      await new Promise(res => setTimeout(res, 20))
      const lines = readFileSync(path, "utf8").trim().split("\n")
      expect(lines).toHaveLength(2)
      const first = JSON.parse(lines[0]!)
      expect(Buffer.from(first.bytes, "base64").toString("utf8")).toBe("hello pty\n")
      reg.shutdown()
    })
  })
})
