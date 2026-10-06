/**
 * A second checkpoint, taken after a first handoff, must describe the work
 * and not the daemon's own plumbing: the handoff question, the source
 * session's JSON reply to it, and the role/AGENTS.md preamble injected at
 * spawn. Runs on a real events.jsonl (no mocked export).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildContextCheckpoint, renderCheckpointPrompt } from "../context-checkpoint.js"
import { HANDOFF_PROMPT, parseHandoffReply } from "../checkpoint-extract.js"
import { HANDOFF_PROMPT_SOURCE } from "../handoff-markers.js"
import { exportDaemonEventsSession } from "../transcript-export.js"
import { setDefaultSessionsBaseDir, sessionEventsPath } from "../transcript-writer.js"
import type { SessionDescriptor } from "../sessions.js"

const SESSION_ID = "sess_hygiene"
const PREAMBLE = "You are the executor. Do the task yourself. This repo has an AGENTS.md contract."
const REPLY_JSON = JSON.stringify({
  goal: "Ship retries for the uploader",
  decisions: ["Use full-jitter backoff"],
  tests: { command: "pnpm test", result: "pass" },
  openRisks: [],
  nextStep: "Seed the RNG",
})

let baseDir: string

function writeEvents(records: Array<Record<string, unknown>>): void {
  const path = sessionEventsPath(SESSION_ID)
  mkdirSync(dirname(path), { recursive: true })
  const lines = records.map((r, i) =>
    JSON.stringify({ seq: i, ts: new Date(1_700_000_000_000 + i * 1000).toISOString(), sessionId: SESSION_ID, ...r }),
  )
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8")
}

const desc = (): SessionDescriptor =>
  ({
    id: SESSION_ID,
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    harness: "claude-code",
    cwd: "/nonexistent-dir-for-git-status",
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
  }) as SessionDescriptor

const FIRST_HANDOFF = [
  { kind: "system-prompt", text: PREAMBLE },
  { kind: "user-prompt", text: "Add exponential-backoff retries to the uploader." },
  { kind: "text-delta", text: "Backoff is in; the retry test still fails on jitter." },
  { kind: "turn-end" },
  { kind: "user-prompt", text: HANDOFF_PROMPT, source: HANDOFF_PROMPT_SOURCE },
  { kind: "text-delta", text: REPLY_JSON },
  { kind: "turn-end" },
]

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "handoff-hygiene-"))
  setDefaultSessionsBaseDir(baseDir)
})

afterEach(() => {
  setDefaultSessionsBaseDir(undefined)
  rmSync(baseDir, { recursive: true, force: true })
})

describe("export tags daemon plumbing", () => {
  it("marks the handoff question, its reply and the preamble, and nothing else", async () => {
    writeEvents(FIRST_HANDOFF)
    const { messages } = await exportDaemonEventsSession(SESSION_ID)
    expect(messages.map(m => [m.role, m.internal])).toEqual([
      ["system", "preamble"],
      ["user", undefined],
      ["assistant", undefined],
      ["user", "handoff"],
      ["assistant", "handoff"],
    ])
  })

  it("recognises a handoff question from its text when the record carries no source", async () => {
    writeEvents([
      { kind: "user-prompt", text: "Do the work." },
      { kind: "text-delta", text: "Done." },
      { kind: "turn-end" },
      { kind: "user-prompt", text: HANDOFF_PROMPT },
      { kind: "text-delta", text: REPLY_JSON },
      { kind: "turn-end" },
      { kind: "user-prompt", text: "Now add docs." },
      { kind: "text-delta", text: "Docs added." },
    ])
    const { messages } = await exportDaemonEventsSession(SESSION_ID)
    expect(messages.map(m => m.internal)).toEqual([undefined, undefined, "handoff", "handoff", undefined, undefined])
  })
})

describe("a second checkpoint after a first handoff", () => {
  it("contains neither the question, nor the JSON reply, nor the preamble", async () => {
    writeEvents(FIRST_HANDOFF)
    const cp = await buildContextCheckpoint(desc(), { contextPct: 40, askSource: false })

    const everything = `${cp.recentDigest}\n${JSON.stringify(cp.sections)}\n${renderCheckpointPrompt(cp)}`
    expect(everything).not.toContain("handoff request from the agentproto daemon")
    expect(everything).not.toContain("Reply with ONLY one JSON object")
    expect(everything).not.toContain('"openRisks"')
    expect(everything).not.toContain("Ship retries for the uploader")
    expect(everything).not.toContain("You are the executor")
    expect(everything).not.toContain("AGENTS.md contract")

    expect(cp.sections.goal).toContain("Add exponential-backoff retries")
    expect(cp.sections.nextStep).toContain("Backoff is in; the retry test still fails on jitter.")
    expect(cp.recentDigest).toContain("Backoff is in")
    expect(parseHandoffReply(cp.sections.nextStep ?? "")).toBeUndefined()
  })
})
