/**
 * Regression test: `agentproto sessions --json` must carry the FULL
 * per-session descriptor through for agent-cli rows — in particular
 * `busy` and `turnsCompleted`, the only fields that let a consumer tell
 * "still working a turn" apart from "finished a turn and sitting idle"
 * (agent-cli sessions stay `status: "running"` after a turn ends, so
 * `status` alone can't answer that). MCP's `session_list` /
 * `agent_sessions_list` read from the exact same `registry.list()` rows
 * with no projection in between — this test locks in that the CLI's
 * `--json` path (`fetchSessions` → `GET /sessions`) stays in parity by
 * construction and doesn't regress if a future change adds an explicit
 * field-picking step.
 *
 * Follows the fake-daemon pattern in sessions-export.test.ts: intercept
 * `discoverDaemon` and `httpGetJson` from _daemon-helpers so no real
 * socket IO happens, then assert on the JSON written to stdout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"
import type { SessionDescriptor } from "@agentproto/runtime"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)

// A busy, mid-turn agent-cli session — the "still working" case.
const busyAgentSession: SessionDescriptor = {
  id: "sess_busy01",
  kind: "agent-cli",
  workspaceSlug: "default",
  command: "hermes acp",
  pid: 12345,
  status: "running",
  startedAt: "2026-07-11T14:00:00.000Z",
  cwd: "/tmp/ws",
  adapterSlug: "hermes",
  adapterSessionId: "acp-busy-1",
  busy: true,
  awaitingInput: false,
  turnsCompleted: 2,
  costUsd: 0.0512,
  tokensIn: 4000,
  tokensOut: 120,
  contextSize: 1048576,
  contextUsed: 40000,
  usageSource: "adapter",
}

// A long-lived agent-cli session that finished its turn — `status` is
// still "running" (matches production behaviour), and `busy` has
// cleared. This is the exact ambiguous case the task is about: without
// `turnsCompleted`, this is indistinguishable from a session that never
// ran a turn at all.
const idleAfterTurnAgentSession: SessionDescriptor = {
  id: "sess_idle01",
  kind: "agent-cli",
  workspaceSlug: "default",
  command: "claude-code",
  pid: 12346,
  status: "running",
  startedAt: "2026-07-11T13:00:00.000Z",
  cwd: "/tmp/ws",
  adapterSlug: "claude-code",
  adapterSessionId: "acp-idle-1",
  busy: false,
  awaitingInput: false,
  turnsCompleted: 1,
  costUsd: 0.0815955,
  tokensIn: 53665,
  tokensOut: 122,
  contextSize: 1048576,
  contextUsed: 74733,
  usageSource: "adapter",
}

// A raw terminal/PTY session — genuinely has no busy/turnsCompleted
// (those concepts don't apply outside agent-cli turns). Included to
// confirm the parity fix doesn't pad unrelated kinds with fields that
// don't apply to them.
const terminalSession: SessionDescriptor = {
  id: "sess_term01",
  kind: "terminal",
  workspaceSlug: "default",
  command: "bash",
  argv: ["bash"],
  pid: 12347,
  status: "running",
  startedAt: "2026-07-11T12:00:00.000Z",
  cwd: "/tmp/ws",
  pty: true,
}

describe("agentproto sessions --json — field parity with MCP session_list/agent_sessions_list", () => {
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stdoutChunks = []
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk))
        return true
      })
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockResolvedValue({
      sessions: [busyAgentSession, idleAfterTurnAgentSession, terminalSession],
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("preserves busy + turnsCompleted for a mid-turn agent-cli session", async () => {
    const code = await runSessions(["--json"])
    expect(code).toBe(0)
    const rows = JSON.parse(stdoutChunks.join("")) as SessionDescriptor[]
    const row = rows.find(r => r.id === "sess_busy01")
    expect(row).toBeDefined()
    expect(row?.busy).toBe(true)
    expect(row?.turnsCompleted).toBe(2)
  })

  it("preserves busy:false + turnsCompleted>=1 for a session idle after finishing a turn — the working-vs-done signal", async () => {
    const code = await runSessions(["--json"])
    expect(code).toBe(0)
    const rows = JSON.parse(stdoutChunks.join("")) as SessionDescriptor[]
    const row = rows.find(r => r.id === "sess_idle01")
    expect(row).toBeDefined()
    expect(row?.status).toBe("running")
    expect(row?.busy).toBe(false)
    expect(row?.turnsCompleted).toBe(1)
  })

  it("also passes through costUsd/contextUsed/contextSize/tokensIn/tokensOut/awaitingInput", async () => {
    const code = await runSessions(["--json"])
    expect(code).toBe(0)
    const rows = JSON.parse(stdoutChunks.join("")) as SessionDescriptor[]
    const row = rows.find(r => r.id === "sess_idle01")
    expect(row?.costUsd).toBe(0.0815955)
    expect(row?.contextUsed).toBe(74733)
    expect(row?.contextSize).toBe(1048576)
    expect(row?.tokensIn).toBe(53665)
    expect(row?.tokensOut).toBe(122)
    expect(row?.awaitingInput).toBe(false)
  })

  it("does not fabricate busy/turnsCompleted for a terminal/pty session that never had them", async () => {
    const code = await runSessions(["--json"])
    expect(code).toBe(0)
    const rows = JSON.parse(stdoutChunks.join("")) as SessionDescriptor[]
    const row = rows.find(r => r.id === "sess_term01")
    expect(row).toBeDefined()
    expect(row?.busy).toBeUndefined()
    expect(row?.turnsCompleted).toBeUndefined()
    expect(row?.pty).toBe(true)
  })
})

describe("agentproto sessions (human table) — idle-after-turn reads distinctly from never-run", () => {
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stdoutChunks = []
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk))
        return true
      })
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("shows the ○ badge for a session idle after a turn, and no badge for one that never ran one", async () => {
    const freshAgentSession: SessionDescriptor = {
      ...idleAfterTurnAgentSession,
      id: "sess_fresh01",
      busy: false,
      turnsCompleted: undefined,
      costUsd: undefined,
      tokensIn: undefined,
      tokensOut: undefined,
    }
    httpGetJson.mockResolvedValue({
      sessions: [idleAfterTurnAgentSession, freshAgentSession],
    })

    const code = await runSessions([])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    const idleLine = out.split("\n").find(l => l.includes("sess_idle01"))
    const freshLine = out.split("\n").find(l => l.includes("sess_fresh01"))
    expect(idleLine).toBeDefined()
    expect(freshLine).toBeDefined()
    expect(idleLine).toContain("○")
    expect(freshLine).not.toContain("○")
  })
})
