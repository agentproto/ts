import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildContextCheckpoint, persistCheckpoint, renderCheckpointPrompt } from "../context-checkpoint.js"
import type { SessionDescriptor } from "../sessions.js"

vi.mock("../transcript-export.js", () => ({
  exportDaemonEventsSession: vi.fn(),
  renderMarkdown: vi.fn((session: { messages: unknown[] }) =>
    session.messages.map((m: unknown) => JSON.stringify(m)).join("\n"),
  ),
}))

import { exportDaemonEventsSession } from "../transcript-export.js"

const baseDesc = (overrides?: Partial<SessionDescriptor>): SessionDescriptor => ({
  id: "sess_test",
  kind: "agent-cli",
  workspaceSlug: "ws",
  command: "claude",
  pid: 123,
  status: "running",
  startedAt: new Date().toISOString(),
  title: "Implement feature",
  model: "claude-sonnet-5",
  effort: "high",
  harness: "claude-code",
  posture: "default",
  contextProfile: "full",
  cwd: "/tmp/repo",
  contextSize: 1000,
  contextUsed: 750,
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
} as SessionDescriptor)

beforeEach(() => {
  vi.mocked(exportDaemonEventsSession).mockResolvedValue({
    meta: {},
    messages: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ],
  })
})

describe("buildContextCheckpoint", () => {

  it("produces a checkpoint with all requested sections", async () => {
    const desc = baseDesc()
    const checkpoint = await buildContextCheckpoint(desc, { contextPct: 75 })
    expect(checkpoint.sourceSessionId).toBe("sess_test")
    expect(checkpoint.contextPct).toBe(75)
    expect(checkpoint.sections.goal).toContain("Implement feature")
    expect(checkpoint.sections.config).toContain("claude-sonnet-5")
    expect(checkpoint.sections.gitStatus).toBeDefined()
    expect(checkpoint.recentDigest).toContain("hello")
  })

  it("references the original transcript path rather than embedding it", async () => {
    const desc = baseDesc()
    const checkpoint = await buildContextCheckpoint(desc, { contextPct: 75 })
    expect(checkpoint.originalTranscriptPath).toContain("sess_test")
    expect(checkpoint.originalTranscriptPath).toContain("events.jsonl")
  })

  it("caps each section to a bounded size", async () => {
    const desc = baseDesc({ title: "x".repeat(5000) })
    const checkpoint = await buildContextCheckpoint(desc, { contextPct: 75 })
    expect((checkpoint.sections.goal ?? "").length).toBeLessThanOrEqual(1300)
  })

  it("gracefully handles missing transcript", async () => {
    vi.mocked(exportDaemonEventsSession).mockRejectedValue(new Error("no file"))
    const desc = baseDesc()
    const checkpoint = await buildContextCheckpoint(desc, { contextPct: 75 })
    expect(checkpoint.recentDigest).toContain("no daemon transcript")
  })
})

describe("persistCheckpoint", () => {
  it("writes checkpoint JSON to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-checkpoint-"))
    const desc = baseDesc()
    const checkpoint = await buildContextCheckpoint(desc, { contextPct: 75, baseDir: dir })
    await persistCheckpoint(checkpoint)
    const written = JSON.parse(readFileSync(checkpoint.checkpointPath, "utf8"))
    expect(written.checkpointId).toBe(checkpoint.checkpointId)
    expect(written.sourceSessionId).toBe("sess_test")
  })
})

describe("renderCheckpointPrompt", () => {
  it("renders a framed prompt with sections and digest", async () => {
    const desc = baseDesc()
    const checkpoint = await buildContextCheckpoint(desc, { contextPct: 75 })
    const prompt = renderCheckpointPrompt(checkpoint)
    expect(prompt).toContain("[continued session")
    expect(prompt).toContain("sess_test")
    expect(prompt).toContain("## goal")
    expect(prompt).toContain("## Recent turns digest")
    expect(prompt).toContain("hello")
  })
})
