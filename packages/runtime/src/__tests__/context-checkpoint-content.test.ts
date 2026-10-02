import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdirSync, mkdtempSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildContextCheckpoint, renderCheckpointPrompt } from "../context-checkpoint.js"
import {
  HandoffUnavailableError,
  createCheckpointSources,
  createRegistryHandoffAsker,
  parseHandoffReply,
  type CheckpointSources,
  type HandoffRegistry,
} from "../checkpoint-extract.js"
import { sessionEventsPath } from "../transcript-writer.js"
import type { SessionDescriptor } from "../sessions.js"
import type { ExportedMessage } from "../transcript-export.js"

vi.mock("../transcript-export.js", () => ({
  exportDaemonEventsSession: vi.fn(),
  renderMarkdown: vi.fn((session: { messages: unknown[] }) =>
    session.messages.map((m: unknown) => JSON.stringify(m)).join("\n"),
  ),
}))

import { exportDaemonEventsSession } from "../transcript-export.js"

const PLACEHOLDER = "captured in recent digest"

const baseDesc = (overrides?: Partial<SessionDescriptor>): SessionDescriptor =>
  ({
    id: "sess_fixture",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    title: "Uploader retries",
    model: "claude-sonnet-5",
    harness: "claude-code",
    cwd: "/nonexistent-dir-for-git-status",
    contextSize: 1000,
    contextUsed: 760,
    contextContinuity: {
      mode: "auto",
      warnAtPct: 55,
      compactAtPct: 65,
      continueFreshAtPct: 75,
      hardStopAtPct: 90,
      goal: true,
      plan: true,
      decisions: true,
      changedFiles: true,
      gitStatus: true,
      tests: true,
      errors: true,
      risks: true,
      nextStep: true,
      config: true,
      label: "auto",
    },
    ...overrides,
  }) as SessionDescriptor

const FIXTURE_MESSAGES: ExportedMessage[] = [
  { role: "system", text: "system preamble that is not the user's ask" },
  { role: "user", text: "Add exponential-backoff retries to the uploader and keep the public API unchanged." },
  {
    role: "assistant",
    text: "Running the suite.",
    toolCalls: [{ name: "Bash", args: JSON.stringify({ command: "pnpm --filter uploader test" }) }],
  },
  { role: "tool", toolName: "Bash", text: "[error] FAIL retry.test.ts\n  2 tests failed" },
  { role: "system", text: "[error] ECONNRESET while uploading chunk 3" },
  { role: "system", text: "[plan] 1/3 add backoff; wire config; update docs" },
  { role: "assistant", text: "Backoff is in; the retry test still fails on jitter." },
]

const GATE_SOURCES: CheckpointSources = {
  lastGate: () => ({
    policyId: "policy_abc",
    kind: "shell",
    command: "pnpm test",
    exitCode: 1,
    at: "2026-10-01T10:00:00.000Z",
    stdout: "Tests  2 failed | 40 passed",
  }),
  openTasks: () => [
    { taskId: "task_1", title: "Fix jitter in retry test", status: "in_progress" },
    { taskId: "task_2", title: "Update docs", status: "pending" },
  ],
}

const HANDOFF_JSON = JSON.stringify({
  goal: "Ship retries for the uploader",
  decisions: ["Use full-jitter backoff because the server rate-limits bursts", "Keep the public API unchanged"],
  tests: { command: "pnpm --filter uploader test", result: "2 failing in retry.test.ts" },
  openRisks: ["jitter is random so the test may be flaky"],
  nextStep: "Seed the RNG in retry.test.ts and re-run",
})

beforeEach(() => {
  vi.mocked(exportDaemonEventsSession).mockResolvedValue({ meta: {}, messages: FIXTURE_MESSAGES })
})

describe("deterministic extraction", () => {
  it("fills goal, tests, nextStep, errors and plan from what the daemon knows", async () => {
    const cp = await buildContextCheckpoint(baseDesc(), {
      contextPct: 76,
      sources: GATE_SOURCES,
      askSource: false,
    })
    expect(cp.sections.goal).toBe(
      "Add exponential-backoff retries to the uploader and keep the public API unchanged.",
    )
    expect(cp.sections.tests).toContain("`pnpm test`")
    expect(cp.sections.tests).toContain("FAILED (exit 1)")
    expect(cp.sections.tests).toContain("2 failed | 40 passed")
    expect(cp.sections.nextStep).toContain("[in_progress] Fix jitter in retry test")
    expect(cp.sections.nextStep).toContain("[pending] Update docs")
    expect(cp.sections.errors).toBe("ECONNRESET while uploading chunk 3")
    expect(cp.sections.plan).toBe("Plan (1/3 steps done): add backoff; wire config; update docs")
    expect(cp.handoffTurn).toEqual({ status: "skipped", reason: "askSource disabled" })
    expect(JSON.stringify(cp)).not.toContain(PLACEHOLDER)
  })

  it("omits decisions and risks instead of inventing placeholders", async () => {
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, askSource: false })
    expect(cp.sections.decisions).toBeUndefined()
    expect(cp.sections.risks).toBeUndefined()
  })

  it("falls back to the last test-like tool call, then to the last agent message", async () => {
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, askSource: false })
    expect(cp.sections.tests).toContain("`pnpm --filter uploader test`")
    expect(cp.sections.tests).toContain("tool reported an error")
    expect(cp.sections.tests).toContain("2 tests failed")
    expect(cp.sections.nextStep).toContain("Backoff is in; the retry test still fails on jitter.")
  })

  it("says so explicitly when no test run was recorded", async () => {
    vi.mocked(exportDaemonEventsSession).mockResolvedValue({
      meta: {},
      messages: [{ role: "user", text: "hi" }],
    })
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, askSource: false })
    expect(cp.sections.tests).toBe("no test run recorded")
  })

  it("uses the descriptor's last error when the transcript has none", async () => {
    vi.mocked(exportDaemonEventsSession).mockResolvedValue({
      meta: {},
      messages: [{ role: "user", text: "hi" }],
    })
    const cp = await buildContextCheckpoint(baseDesc({ lastTurnErrorMessage: "rate limited" }), {
      contextPct: 76,
      askSource: false,
    })
    expect(cp.sections.errors).toBe("rate limited")
  })

  it("recovers the original goal from a continued session's checkpoint prompt", async () => {
    vi.mocked(exportDaemonEventsSession).mockResolvedValue({
      meta: {},
      messages: [
        {
          role: "user",
          text: "[continued session — this is a structured handoff]\n\nSource: x\n\n## goal\nOriginal ask\n\n## tests\nfoo\n\n## Recent turns digest\nbar",
        },
      ],
    })
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, askSource: false })
    expect(cp.sections.goal).toBe("Original ask")
  })

  it("reads gate results and open tasks through createCheckpointSources", () => {
    const sources = createCheckpointSources({
      supervisor: {
        list: () => [
          {
            policyId: "policy_old",
            sessionId: "s1",
            sessionIds: ["s1"],
            pending: [],
            status: "done",
            retries: 0,
            startedAt: "2026-10-01T09:00:00.000Z",
            lastGate: { exitCode: 0, at: "2026-10-01T09:05:00.000Z", kind: "shell", command: "pnpm lint" },
          },
          {
            policyId: "policy_new",
            sessionId: "s1",
            sessionIds: ["s1"],
            pending: [],
            status: "blocked",
            retries: 0,
            startedAt: "2026-10-01T09:00:00.000Z",
            lastGate: { exitCode: 1, at: "2026-10-01T09:10:00.000Z", kind: "shell", command: "pnpm test" },
          },
          {
            policyId: "policy_other",
            sessionId: "s2",
            sessionIds: ["s2"],
            pending: [],
            status: "done",
            retries: 0,
            startedAt: "2026-10-01T09:00:00.000Z",
            lastGate: { exitCode: 0, at: "2026-10-01T09:20:00.000Z", kind: "shell", command: "other" },
          },
        ],
      },
      taskLedger: {
        snapshot: () =>
          [
            { taskId: "t1", title: "done one", status: "done", owner: "s1" },
            { taskId: "t2", title: "pending one", status: "pending", sessions: ["s1"] },
            { taskId: "t3", title: "active one", status: "in_progress", owner: "s1" },
            { taskId: "t4", title: "someone else's", status: "in_progress", owner: "s2" },
          ] as never,
      },
    })
    expect(sources.lastGate?.("s1")).toMatchObject({ policyId: "policy_new", command: "pnpm test", exitCode: 1 })
    expect(sources.openTasks?.("s1")?.map(t => t.taskId)).toEqual(["t3", "t2"])
  })
})

describe("handoff turn", () => {
  it("uses the source session's answer for decisions, risks, tests and next step", async () => {
    const asker = vi.fn(async () => `Here you go:\n\`\`\`json\n${HANDOFF_JSON}\n\`\`\``)
    const cp = await buildContextCheckpoint(baseDesc(), {
      contextPct: 76,
      sources: GATE_SOURCES,
      handoffAsker: asker,
    })
    expect(asker).toHaveBeenCalledTimes(1)
    expect(cp.handoffTurn).toEqual({ status: "answered" })
    expect(cp.sections.decisions).toContain("- Use full-jitter backoff because the server rate-limits bursts")
    expect(cp.sections.risks).toContain("- jitter is random so the test may be flaky")
    expect(cp.sections.nextStep).toContain("Seed the RNG in retry.test.ts and re-run")
    expect(cp.sections.nextStep).toContain("[in_progress] Fix jitter in retry test")
    expect(cp.sections.tests).toContain("FAILED (exit 1)")
    expect(cp.sections.tests).toContain("Reported by the source agent: `pnpm --filter uploader test` — 2 failing")
    expect(cp.sections.goal).toContain("Add exponential-backoff retries")
    expect(cp.sections.goal).toContain("Current goal (per the source session): Ship retries for the uploader")
    expect(JSON.stringify(cp)).not.toContain(PLACEHOLDER)
  })

  it("does not put the handoff exchange into the digest", async () => {
    const cp = await buildContextCheckpoint(baseDesc(), {
      contextPct: 76,
      handoffAsker: async () => HANDOFF_JSON,
    })
    expect(cp.recentDigest).not.toContain("handoff request")
  })

  it.each([
    ["the asker throws", async () => Promise.reject(new Error("boom"))],
    ["the reply is not JSON", async () => "I cannot do that."],
    ["the reply fails validation", async () => JSON.stringify({ decisions: "not-an-array" })],
    ["the reply is an empty object", async () => "{}"],
  ])("falls back to extraction when %s", async (_label, asker) => {
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, sources: GATE_SOURCES, handoffAsker: asker })
    expect(cp.handoffTurn?.status).toBe("failed")
    expect(cp.sections.decisions).toBeUndefined()
    expect(cp.sections.nextStep).toContain("[in_progress] Fix jitter in retry test")
    expect(cp.sections.goal).toContain("Add exponential-backoff retries")
  })

  it("does not ask when askSource is false", async () => {
    const asker = vi.fn(async () => HANDOFF_JSON)
    await buildContextCheckpoint(baseDesc(), { contextPct: 76, handoffAsker: asker, askSource: false })
    expect(asker).not.toHaveBeenCalled()
  })

  it("skips quietly when the session cannot take a turn", async () => {
    const cp = await buildContextCheckpoint(baseDesc(), {
      contextPct: 76,
      handoffAsker: async () => Promise.reject(new HandoffUnavailableError("source session is busy")),
    })
    expect(cp.handoffTurn).toEqual({ status: "skipped", reason: "source session is busy" })
  })

  it("skips when no registry or asker is available", async () => {
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76 })
    expect(cp.handoffTurn?.status).toBe("skipped")
  })
})

describe("registry-backed asker", () => {
  const makeFixture = (): { baseDir: string; eventsPath: string } => {
    const baseDir = mkdtempSync(join(tmpdir(), "handoff-asker-"))
    const eventsPath = sessionEventsPath("sess_fixture", baseDir)
    mkdirSync(dirname(eventsPath), { recursive: true })
    appendFileSync(eventsPath, `${JSON.stringify({ kind: "text-delta", text: "earlier message" })}\n`)
    return { baseDir, eventsPath }
  }

  it("prompts the idle session and reads its reply from the transcript", async () => {
    const { baseDir, eventsPath } = makeFixture()
    const registry = {
      get: () => ({ ...baseDesc(), busy: false }),
      sendPrompt: vi.fn(async () => {
        appendFileSync(eventsPath, `${JSON.stringify({ kind: "user-prompt", text: "q" })}\n`)
        appendFileSync(eventsPath, `${JSON.stringify({ kind: "text-delta", text: HANDOFF_JSON })}\n`)
      }),
    } as unknown as HandoffRegistry
    const asker = createRegistryHandoffAsker(registry, baseDesc(), baseDir)!
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, baseDir, handoffAsker: asker })
    expect(cp.handoffTurn).toEqual({ status: "answered" })
    expect(cp.sections.decisions).toContain("full-jitter")
    expect(registry.sendPrompt).toHaveBeenCalledWith("sess_fixture", expect.stringContaining("handoff request"), {
      source: "daemon:handoff",
    })
  })

  it("is used by buildContextCheckpoint when only a registry is given", async () => {
    const { baseDir, eventsPath } = makeFixture()
    const registry = {
      get: () => ({ ...baseDesc(), busy: false }),
      sendPrompt: async () => {
        appendFileSync(eventsPath, `${JSON.stringify({ kind: "text-delta", text: HANDOFF_JSON })}\n`)
      },
    } as unknown as HandoffRegistry
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, baseDir, registry })
    expect(cp.handoffTurn).toEqual({ status: "answered" })
  })

  it("times out, interrupts the session and falls back", async () => {
    const { baseDir } = makeFixture()
    const interruptSession = vi.fn(async () => ({ wasBusy: true }))
    const registry = {
      get: () => ({ ...baseDesc(), busy: false }),
      sendPrompt: () => new Promise<void>(() => undefined),
      interruptSession,
    } as unknown as HandoffRegistry
    const cp = await buildContextCheckpoint(baseDesc(), {
      contextPct: 76,
      baseDir,
      registry,
      askTimeoutMs: 25,
    })
    expect(cp.handoffTurn?.status).toBe("failed")
    expect(cp.handoffTurn?.reason).toContain("did not answer within 25ms")
    expect(interruptSession).toHaveBeenCalledWith("sess_fixture")
    expect(cp.sections.decisions).toBeUndefined()
    expect(cp.sections.goal).toContain("Add exponential-backoff retries")
  })

  it.each([
    ["dead", { status: "exited" }],
    ["busy", { status: "running", busy: true }],
    ["waiting on input", { status: "running", awaitingInput: true }],
  ])("skips without prompting a %s session", async (_label, patch) => {
    const sendPrompt = vi.fn()
    const registry = { get: () => ({ ...baseDesc(), ...patch }), sendPrompt } as unknown as HandoffRegistry
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, registry })
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(cp.handoffTurn?.status).toBe("skipped")
  })

  it("falls back when the turn adds no new assistant text", async () => {
    const { baseDir } = makeFixture()
    const registry = {
      get: () => ({ ...baseDesc(), busy: false }),
      sendPrompt: async () => undefined,
    } as unknown as HandoffRegistry
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, baseDir, registry })
    expect(cp.handoffTurn?.status).toBe("failed")
  })
})

describe("operator notes", () => {
  it("carries notes verbatim into a notes section and renders them", async () => {
    const cp = await buildContextCheckpoint(baseDesc(), {
      contextPct: 76,
      askSource: false,
      notes: "Decision: stay on the v2 endpoint until Friday.",
    })
    expect(cp.sections.notes).toBe("Decision: stay on the v2 endpoint until Friday.")
    expect(renderCheckpointPrompt(cp)).toContain("## notes (from the operator)\nDecision: stay on the v2 endpoint until Friday.")
  })

  it("omits the notes section when none are given or they are blank", async () => {
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, askSource: false, notes: "   " })
    expect(cp.sections.notes).toBeUndefined()
  })
})

describe("renderCheckpointPrompt", () => {
  it("renders every filled section and no placeholder", async () => {
    const cp = await buildContextCheckpoint(baseDesc(), {
      contextPct: 76,
      sources: GATE_SOURCES,
      notes: "keep v2",
      handoffAsker: async () => HANDOFF_JSON,
    })
    const prompt = renderCheckpointPrompt(cp)
    for (const heading of ["## goal", "## plan", "## decisions", "## tests", "## errors", "## risks", "## nextStep"]) {
      expect(prompt).toContain(heading)
    }
    expect(prompt).not.toContain(PLACEHOLDER)
    expect(prompt).toContain("Continue from the 'next step' above")
  })

  it("does not point at a next step that does not exist", async () => {
    vi.mocked(exportDaemonEventsSession).mockRejectedValue(new Error("no file"))
    const cp = await buildContextCheckpoint(baseDesc(), { contextPct: 76, askSource: false })
    expect(renderCheckpointPrompt(cp)).not.toContain("'next step' above")
  })
})

describe("parseHandoffReply", () => {
  it("accepts bare JSON, fenced JSON and JSON surrounded by prose", () => {
    expect(parseHandoffReply(HANDOFF_JSON)?.nextStep).toBe("Seed the RNG in retry.test.ts and re-run")
    expect(parseHandoffReply(`\`\`\`json\n${HANDOFF_JSON}\n\`\`\``)?.decisions).toHaveLength(2)
    expect(parseHandoffReply(`Sure! ${HANDOFF_JSON} Hope that helps {not json}`)?.openRisks).toHaveLength(1)
  })

  it("rejects unusable replies", () => {
    expect(parseHandoffReply("")).toBeUndefined()
    expect(parseHandoffReply("{ nope")).toBeUndefined()
    expect(parseHandoffReply('{"decisions":[],"openRisks":[]}')).toBeUndefined()
  })
})
