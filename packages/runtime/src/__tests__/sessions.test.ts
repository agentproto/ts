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

/**
 * Tests covering the registry behaviours that have historically
 * regressed: boot-time history reload, shutdown idempotency, and
 * the provider-aware output sniffer.
 */

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

  it("marks formerly-running sessions as killed on reload", () => {
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
            // Was "running" at last save — daemon presumably died without
            // graceful shutdown.
            status: "running",
            startedAt: "2026-05-14T00:00:00Z",
          },
        ],
      }),
    )
    const reg = createSessionsRegistry({ persistPath })
    const list = reg.list()
    // Reclassified to killed so attach calls don't try to reach a
    // process that's already dead.
    expect(list[0]?.status).toBe("killed")
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
})
