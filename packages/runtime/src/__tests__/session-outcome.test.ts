/**
 * Derived session outcome (Level 1): every ended agent-cli session gets one
 * `outcome` record — what it produced — derived by the daemon from what it
 * already knows, recorded from the registry's single exit funnel and from
 * boot reconcile.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWorkflow, type RuntimeWorkflow } from "@agentproto/workflow-runtime"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionDescriptor } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { SessionsRegistryAgentHost } from "../sessions-registry-agent-host.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { runIdleReapPass } from "../idle-reaper.js"
import {
  compactOutcome,
  deriveSessionOutcome,
  readLastAssistantTextSync,
  shouldReplaceOutcome,
  OUTCOME_SUMMARY_MAX,
} from "../session-outcome.js"

/** An agent session whose turn streams `events`, then parks until `release`
 *  is called — so a test can kill it mid-turn. */
function parkedAgentSession(events: AgentStreamEvent[]): { session: AgentSessionLike; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>(res => {
    release = res
  })
  return {
    release,
    session: {
      sessionId: "acp-parked",
      async *send() {
        for (const e of events) yield e
        await gate
      },
      async cancel() {},
      async close() {},
    },
  }
}

/** An agent session whose turn streams `events` and ends. */
function turnSession(events: AgentStreamEvent[]): AgentSessionLike {
  return {
    sessionId: "acp-turn",
    async *send() {
      for (const e of events) yield e
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

const tick = (ms = 10) => new Promise(res => setTimeout(res, ms))

describe("derived session outcome — registry", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-outcome-"))
  })
  afterEach(async () => {
    // Let the transcript writer's async stream opens settle before the dir
    // goes away (same as interrupted-turn-contract.test.ts).
    await tick(30)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("killed mid-turn ⇒ outcome with termination killed + what was said so far", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: createSessionEventBus() })
    const parked = parkedAgentSession([
      { kind: "text-delta", text: "Looking at the " },
      { kind: "text-delta", text: "repo first." },
      { kind: "tool-call", toolCallId: "t1", toolName: "Read", arguments: { file_path: "/x" } },
      { kind: "tool-result", toolCallId: "t1", result: "ok" },
      { kind: "text-delta", text: "Found the bug in parser.ts;\nfixing it now." },
    ])
    const desc = reg.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: parked.session, adapterSlug: "claude-code" })
    const turn = reg.sendPrompt(desc.id, "fix it").catch(() => undefined)
    await tick()
    expect(reg.get(desc.id)?.busy).toBe(true)

    reg.kill(desc.id)
    const outcome = reg.get(desc.id)?.outcome
    expect(outcome).toMatchObject({
      source: "derived",
      status: "produced",
      // Last message only (after the tool call), whitespace collapsed.
      summary: "Found the bug in parser.ts; fixing it now.",
      termination: { status: "killed", midTurn: true },
    })
    expect(outcome?.cost?.durationMs).toBeGreaterThanOrEqual(0)
    parked.release()
    await turn
    reg.shutdown()
  })

  it("a natural exit with no assistant text ⇒ status empty", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: turnSession([]), adapterSlug: "claude-code" })
    await reg.sendPrompt(desc.id, "hi")
    reg.kill(desc.id)
    expect(reg.get(desc.id)?.outcome).toMatchObject({ status: "empty", termination: { status: "killed" } })
    expect(reg.get(desc.id)?.outcome?.summary).toBeUndefined()
    expect(reg.get(desc.id)?.outcome?.termination.midTurn).toBeUndefined()
    reg.shutdown()
  })

  it("idle-reaped ⇒ outcome carrying the reason, the last message and cost", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: createSessionEventBus() })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: turnSession([{ kind: "text-delta", text: "All done: tests green." }]),
      adapterSlug: "claude-code",
    })
    await reg.sendPrompt(desc.id, "go")
    const live = reg.get(desc.id)!
    live.lastActivityAt = "2020-01-01T00:00:00Z"
    live.costUsd = 0.42
    live.tokensIn = 1200
    live.tokensOut = 300
    runIdleReapPass({ registry: reg, idleReapAfterMs: 1_000, now: () => Date.now() })

    expect(reg.get(desc.id)?.outcome).toMatchObject({
      status: "produced",
      summary: "All done: tests green.",
      termination: { status: "killed", reason: "idle-reaped" },
      cost: { usd: 0.42, tokensIn: 1200, tokensOut: 300 },
    })
    reg.shutdown()
  })

  it("markCrashed ⇒ outcome with termination error/crashed", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: createSessionEventBus() })
    const desc = reg.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: turnSession([]), adapterSlug: "claude-code" })
    expect(reg.markCrashed(desc.id)).toBe(true)
    expect(reg.get(desc.id)?.outcome?.termination).toEqual({ status: "error", reason: "crashed" })
    reg.shutdown()
  })

  it("a session that opened a PR ⇒ pr artifact, including a PR recorded after the exit", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const a = reg.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: turnSession([]), adapterSlug: "claude-code" })
    reg.recordOpenedPr(a.id, { adapter: "github", number: 42, url: "https://github.com/o/r/pull/42" })
    reg.kill(a.id)
    expect(reg.get(a.id)?.outcome).toMatchObject({
      status: "produced",
      artifacts: [{ type: "pr", ref: "https://github.com/o/r/pull/42", title: "#42" }],
    })

    // The provenance stamp can land after the session ended: folded in.
    const b = reg.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: turnSession([]), adapterSlug: "claude-code" })
    reg.kill(b.id)
    expect(reg.get(b.id)?.outcome?.status).toBe("empty")
    reg.recordOpenedPr(b.id, { adapter: "github", number: 7, url: "https://github.com/o/r/pull/7" })
    expect(reg.get(b.id)?.outcome).toMatchObject({
      status: "produced",
      artifacts: [{ type: "pr", ref: "https://github.com/o/r/pull/7" }],
    })
    reg.shutdown()
  })

  it("idempotent: two terminal transitions ⇒ one outcome (first write wins)", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: turnSession([]), adapterSlug: "claude-code" })
    reg.kill(desc.id)
    const first = reg.get(desc.id)?.outcome
    expect(first).toBeDefined()
    reg.kill(desc.id)
    reg.markCrashed(desc.id)
    expect(reg.get(desc.id)?.outcome).toBe(first)
    reg.shutdown()
  })

  it("non-agent sessions get no outcome", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.recordCommand({
      workspaceSlug: "default",
      cwd: tmp,
      command: "echo",
      args: ["hi"],
      exitCode: 0,
      signal: null,
      stdout: "hi\n",
      stderr: "",
      durationMs: 1,
    })
    expect(reg.get(desc.id)?.outcome).toBeUndefined()
    await reg.settlePendingWrites()
    reg.shutdown()
  })

  it("restart: a persisted outcome survives reload (and archiving)", () => {
    const persistPath = join(tmp, "sessions.json")
    const reg = createSessionsRegistry({ persistPath, transcriptDir: tmp })
    const desc = reg.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: turnSession([]), adapterSlug: "claude-code" })
    reg.recordOpenedPr(desc.id, { adapter: "github", number: 1, url: "https://github.com/o/r/pull/1" })
    reg.kill(desc.id)
    reg.archiveSession(desc.id)
    const before = reg.get(desc.id)?.outcome
    reg.shutdown()

    const reloaded = createSessionsRegistry({ persistPath, transcriptDir: tmp })
    const after = reloaded.get(desc.id)
    expect(after?.archived).toBe(true)
    expect(after?.outcome).toEqual(before)
    reloaded.shutdown()
  })

  it("restart reconcile: a row that died with the daemon gets an outcome, summary read from its transcript tail", () => {
    const persistPath = join(tmp, "sessions.json")
    const id = "sess_diedwithdaemon"
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-09-26T00:00:00Z",
        sessions: [
          {
            id,
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "claude (agent)",
            pid: null,
            status: "running",
            startedAt: "2026-09-26T00:00:00Z",
            busy: true,
            adapterSlug: "claude-code",
            cwd: tmp,
            parentSessionId: "sess_parent",
          },
        ],
      }),
    )
    mkdirSync(join(tmp, id), { recursive: true })
    writeFileSync(
      join(tmp, id, "events.jsonl"),
      [
        { seq: 1, kind: "user-prompt", text: "go" },
        { seq: 2, kind: "text-delta", text: "Earlier message.\n" },
        { seq: 3, kind: "tool-call", toolCallId: "t", toolName: "Bash" },
        { seq: 4, kind: "text-delta", text: "Opened the PR,\n" },
        { seq: 5, kind: "text-delta", text: "waiting on CI.\n" },
        { seq: 6, kind: "usage_update", used: 1 },
      ]
        .map(r => JSON.stringify(r))
        .join("\n") + "\n",
    )

    const reg = createSessionsRegistry({ persistPath, transcriptDir: tmp })
    expect(reg.get(id)?.outcome).toMatchObject({
      status: "produced",
      summary: "Opened the PR, waiting on CI.",
      termination: { status: "killed", reason: "daemon-restart", midTurn: true },
      links: [{ rel: "parent", ref: "sess_parent" }],
    })
    reg.shutdown()
  })
})

describe("derived session outcome — workflow step release", () => {
  it("a released workflow step session links its run", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async () => ({
      startSession: async () => turnSession([]),
      commandPreview: "fake",
    }))
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter, {
      run: { runId: "wfrun_9", workflowId: "maintain" },
    })
    host.sendPromptAndWait = vi.fn(async () => {})
    host.readFinalMessage = vi.fn(async () => "ok")
    const wf: RuntimeWorkflow = {
      id: "maintain",
      steps: [{ kind: "agent", id: "review", adapter: "claude-code", prompt: () => "go" }],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    const sessionId = (output as { sessionId: string }).sessionId
    const d = registry.get(sessionId)!
    expect(d.status).toBe("killed")
    expect(d.outcome?.links).toEqual([{ rel: "run", ref: "wfrun_9", title: "maintain/review" }])
    registry.shutdown()
  })
})

describe("derived session outcome — pure helpers", () => {
  const base: SessionDescriptor = {
    id: "s",
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "x",
    pid: null,
    status: "killed",
    startedAt: "2026-09-26T00:00:00.000Z",
    endedAt: "2026-09-26T00:01:00.000Z",
  }

  it("keeps the tail of a long summary, and the compact projection keeps 120 head chars", () => {
    const long = "a".repeat(400) + " " + "z".repeat(400)
    const o = deriveSessionOutcome(base, { lastAssistantText: long })
    expect(o.summary!.length).toBe(OUTCOME_SUMMARY_MAX)
    expect(o.summary!.startsWith("…")).toBe(true)
    expect(o.summary!.endsWith("z")).toBe(true)
    expect(o.cost).toEqual({ durationMs: 60_000 })
    const c = compactOutcome(o)!
    expect(c.status).toBe("produced")
    expect(c.summary!.length).toBe(120)
  })

  it("shouldReplaceOutcome: first write wins; a new death or a richer write replaces", () => {
    const empty = deriveSessionOutcome(base)
    const again = deriveSessionOutcome(base)
    expect(shouldReplaceOutcome(undefined, empty)).toBe(true)
    expect(shouldReplaceOutcome(empty, again)).toBe(false)
    expect(shouldReplaceOutcome(empty, deriveSessionOutcome(base, { lastAssistantText: "hi" }))).toBe(true)
    expect(shouldReplaceOutcome(empty, deriveSessionOutcome({ ...base, status: "error", endedReason: "crashed" }))).toBe(true)
  })

  it("readLastAssistantTextSync tolerates a missing file and a torn first line", () => {
    expect(readLastAssistantTextSync("/nonexistent/events.jsonl")).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), "outcome-tail-"))
    const p = join(dir, "events.jsonl")
    writeFileSync(p, `ind":"text-delta","text":"torn"}\n${JSON.stringify({ kind: "text-delta", text: "whole" })}\n`)
    expect(readLastAssistantTextSync(p)).toBe("whole")
    rmSync(dir, { recursive: true, force: true })
  })
})
