/**
 * The ONE bounded harness escalation: reply parsing (closed set), the
 * single-attempt wrapper, and the daemon host against a REAL sessions
 * registry + event bus + event ring with a fake adapter (pattern from
 * review-reviewer-host.test.ts). HOME is a temp dir so spawn-core config
 * reads see nothing.
 */

import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildEscalationPrompt,
  createBoundedEscalation,
  createDaemonEscalationHost,
  parseEscalationReply,
  type EscalationHost,
  type EscalationHostResult,
  type EscalationHostRun,
} from "../decision-escalation.js"
import { resolveExecProfile, type DecisionExecProfile, type ResolvedTarget } from "../decision-profile.js"
import { createEventRing } from "../event-ring.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"

vi.setConfig({ testTimeout: 30_000 })

const CHOICES = ["light", "standard", "deep"] as const

describe("parseEscalationReply — closed set only", () => {
  it("accepts the last {choice} object inside the set", () => {
    expect(parseEscalationReply('thinking…\n{"choice":"standard"}', CHOICES)).toEqual({ ok: true, choice: "standard" })
    expect(parseEscalationReply('{"choice":"light"} then {"choice":"deep"}', CHOICES)).toEqual({ ok: true, choice: "deep" })
    expect(parseEscalationReply('{"choice":" deep "}', CHOICES)).toEqual({ ok: true, choice: "deep" })
  })

  it("rejects a choice outside the set, an empty reply and a non-object reply", () => {
    expect(parseEscalationReply('{"choice":"ultra"}', CHOICES)).toMatchObject({ ok: false })
    expect(parseEscalationReply("", CHOICES)).toMatchObject({ ok: false })
    expect(parseEscalationReply("I pick deep", CHOICES)).toMatchObject({ ok: false })
    expect(parseEscalationReply('{"choice":7}', CHOICES)).toMatchObject({ ok: false })
  })

  it("the prompt lists the closed choices and does not claim tool enforcement", () => {
    const p = buildEscalationPrompt("PACKET", CHOICES)
    expect(p).toContain("light | standard | deep")
    expect(p).toContain("PACKET")
  })
})

const TARGET: Extract<ResolvedTarget, { ok: true }> = {
  ok: true,
  adapter: "opencode",
  model: "glm-free",
  profileRef: "zen",
  fingerprint: "fp",
  spawn: { adapter: "opencode", model: "glm-free" },
}
const OWNER = { runId: "run-1", workflowId: "decision-route", stepId: "escalate" }

function fakeHost(result: EscalationHostResult | (() => Promise<EscalationHostResult>)): EscalationHost & { runs: EscalationHostRun[] } {
  const runs: EscalationHostRun[] = []
  return {
    runs,
    async run(input) {
      runs.push(input)
      return typeof result === "function" ? result() : result
    },
  }
}

const controls = {
  configured: { posture: "read-only" as const, mcpServers: "none" as const },
  enforced: {
    posture: "prompt-advisory" as const,
    mcpServers: "none-mounted" as const,
    commandSandbox: "not-requested" as const,
    harnessBuiltinToolsAvailable: true as const,
  },
}

describe("createBoundedEscalation — one attempt, failures as data", () => {
  const make = (host: EscalationHost) =>
    createBoundedEscalation({ host, target: TARGET, choices: CHOICES, timeoutMs: 5_000, owner: OWNER, label: "decide:escalate", parentSessionId: "parent-1" })

  it("decides from a valid reply and records who ran, where and why", async () => {
    const host = fakeHost({ status: "ended", text: '{"choice":"deep"}', sessionId: "s1", model: "glm-free", toolControls: controls })
    const esc = make(host)
    expect(await esc.escalate({ packet: "p" })).toEqual({ ok: true, choice: "deep" })
    expect(esc.record()).toMatchObject({
      attempted: true,
      status: "decided",
      wait: "turn",
      adapter: "opencode",
      model: "glm-free",
      actualModel: "glm-free",
      sessionId: "s1",
      toolControls: controls,
    })
    expect(host.runs[0]).toMatchObject({ owner: OWNER, parentSessionId: "parent-1", timeoutMs: 5_000, spawn: TARGET.spawn })
  })

  it("a second call never reaches the host", async () => {
    const host = fakeHost({ status: "ended", text: '{"choice":"light"}', sessionId: "s1", toolControls: controls })
    const esc = make(host)
    await esc.escalate({ packet: "p" })
    expect(await esc.escalate({ packet: "p" })).toMatchObject({ ok: false, error: expect.stringMatching(/limit reached/) })
    expect(host.runs).toHaveLength(1)
  })

  it("timeout / cancelled / failed keep their own status and wait reason", async () => {
    for (const [status, wait] of [
      ["timeout", "timeout"],
      ["cancelled", "cancelled"],
      ["failed", "human-input-required"],
      ["failed", "provider-unavailable"],
    ] as const) {
      const esc = make(fakeHost({ status, wait, error: `${status}!`, sessionId: "s2" }))
      expect(await esc.escalate({ packet: "p" })).toEqual({ ok: false, error: `${status}!` })
      expect(esc.record()).toMatchObject({ attempted: true, status, wait, reason: `${status}!`, sessionId: "s2" })
    }
  })

  it("an out-of-set reply is invalid-reply, not a decision", async () => {
    const esc = make(fakeHost({ status: "ended", text: '{"choice":"ultra"}', sessionId: "s3", toolControls: controls }))
    expect(await esc.escalate({ packet: "p" })).toMatchObject({ ok: false })
    expect(esc.record()).toMatchObject({ status: "invalid-reply" })
  })

  it("a host that throws is a failed attempt, not an exception", async () => {
    const esc = make({
      async run() {
        throw new Error("boom")
      },
    })
    expect(await esc.escalate({ packet: "p" })).toEqual({ ok: false, error: "boom" })
    expect(esc.record()).toMatchObject({ status: "failed", wait: "provider-unavailable" })
  })

  it("before any call the record says not-attempted", () => {
    expect(make(fakeHost({ status: "failed", wait: "none", error: "x" })).record()).toMatchObject({ attempted: false, status: "not-attempted" })
  })
})

// ── daemon host: real registry/bus/ring, fake adapter ─────────────────────

type Behaviour = "reply" | "hang" | "empty" | "error" | "ask" | `say:${string}`

function fakeSession(behaviour: Behaviour, seen: string[]): AgentSessionLike {
  let release: (() => void) | undefined
  const closed = new Promise<void>(r => (release = r))
  return {
    sessionId: "fake-escalation",
    async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
      seen.push(typeof message === "string" ? message : JSON.stringify(message))
      if (behaviour === "hang") {
        await closed
        return
      }
      if (behaviour === "empty") {
        yield { kind: "turn-end", reason: "completed" }
        return
      }
      if (behaviour === "error") {
        yield { kind: "error", error: { message: "provider down" } }
        yield { kind: "turn-end", reason: "error" }
        return
      }
      const text = behaviour.startsWith("say:") ? behaviour.slice(4) : '{"choice":"standard"}'
      yield { kind: "text-delta", text: `${text}\n` }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {
      release?.()
    },
    async close() {
      release?.()
    },
  }
}

let home: string
let prevHome: string | undefined
beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-decision-esc-"))
  process.env.HOME = home
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

function setup(behaviour: Behaviour, profileId = "local-free") {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const eventRing = createEventRing()
  eventRing.wire(sessionEvents)
  const seen: string[] = []
  const spawnedWith: Array<Record<string, unknown>> = []
  const resolveAgentAdapter: AgentAdapterResolver = async () =>
    ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startSession: (async (opts: Record<string, unknown>) => {
        spawnedWith.push(opts)
        return fakeSession(behaviour, seen)
      }) as any,
      commandPreview: "fake-escalation",
    }) as never
  const r = resolveExecProfile({ profile: profileId })
  if (!r.ok) throw new Error(r.error)
  const profile: DecisionExecProfile = r.profile
  const host = createDaemonEscalationHost({
    registry,
    sessionEvents,
    eventRing,
    resolveAgentAdapter,
    profile,
    spawnDeps: { loadDefaultsConfig: async () => undefined, loadRoleRegistry: async () => ({}) },
  })
  return { host, registry, seen, spawnedWith }
}

const runInput = (over: Partial<EscalationHostRun> = {}): EscalationHostRun => ({
  spawn: { adapter: "opencode", model: "glm-free" },
  prompt: buildEscalationPrompt("packet", CHOICES),
  label: "decide:escalate",
  timeoutMs: 10_000,
  owner: OWNER,
  ...over,
})

describe("createDaemonEscalationHost — child session lifecycle", () => {
  it("spawns one read-only session with no MCP tools mounted in a scratch cwd, returns its reply, then kills + archives + removes scratch", async () => {
    const { host, registry, spawnedWith } = setup("reply")
    const res = await host.run(runInput({ parentSessionId: "parent-9" }))
    expect(res.status).toBe("ended")
    if (res.status !== "ended") throw new Error("expected ended")
    expect(parseEscalationReply(res.text, CHOICES)).toEqual({ ok: true, choice: "standard" })
    expect(spawnedWith).toHaveLength(1)

    const desc = registry.get(res.sessionId)!
    expect(desc.status).toBe("killed")
    expect(desc.archived).toBe(true)
    expect(desc.label).toBe("decide:escalate")
    expect(desc.parentSessionId).toBe("parent-9")
    expect(desc.meta).toMatchObject({ workflowRunId: "run-1", workflowId: "decision-route", workflowStepId: "escalate" })

    const cwd = String(spawnedWith[0]!.cwd)
    expect(cwd).toContain("agp-decision-escalate-")
    expect(existsSync(cwd)).toBe(false)

    expect(res.toolControls.configured).toMatchObject({ posture: "read-only", mcpServers: "none" })
    expect(res.toolControls.enforced).toMatchObject({ mcpServers: "none-mounted", harnessBuiltinToolsAvailable: true })
    expect(["native", "prompt-advisory", "none", "unknown"]).toContain(res.toolControls.enforced.posture)
    registry.shutdown()
  })

  it("a timeout kills the hung session and reports wait=timeout", async () => {
    const { host, registry } = setup("hang")
    const res = await host.run(runInput({ timeoutMs: 300 }))
    expect(res).toMatchObject({ status: "timeout", wait: "timeout" })
    if (res.status !== "timeout" || !res.sessionId) throw new Error("expected timeout with a session")
    expect(registry.get(res.sessionId)!.status).toBe("killed")
    expect(registry.get(res.sessionId)!.archived).toBe(true)
    registry.shutdown()
  })

  it("cancel mid-run kills the session and reports wait=cancelled", async () => {
    const { host, registry } = setup("hang")
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const res = await host.run(runInput({ signal: ac.signal }))
    expect(res).toMatchObject({ status: "cancelled", wait: "cancelled" })
    if (res.status !== "cancelled" || !res.sessionId) throw new Error("expected cancelled with a session")
    expect(registry.get(res.sessionId)!.status).toBe("killed")
    registry.shutdown()
  })

  it("an already-aborted signal spawns nothing", async () => {
    const { host, registry, spawnedWith } = setup("reply")
    const ac = new AbortController()
    ac.abort()
    expect(await host.run(runInput({ signal: ac.signal }))).toMatchObject({ status: "cancelled" })
    expect(spawnedWith).toHaveLength(0)
    registry.shutdown()
  })

  it("an empty turn and an error turn are provider-unavailable, not decisions", async () => {
    for (const b of ["empty", "error"] as const) {
      const { host, registry } = setup(b)
      const res = await host.run(runInput())
      expect(res).toMatchObject({ status: "failed", wait: "provider-unavailable" })
      registry.shutdown()
    }
  })

  it("re-validates the LIVE identity: a free-only host refuses a Sonnet session it was handed", async () => {
    const { host, registry } = setup("reply")
    const res = await host.run(runInput({ spawn: { adapter: "claude-code", model: "claude-sonnet-4-5" } }))
    expect(res).toMatchObject({ status: "failed", wait: "none", error: expect.stringMatching(/identity refused/) })
    if (res.status === "ended" || !res.sessionId) throw new Error("expected a failed run with a session id")
    expect(registry.get(res.sessionId)!.status).toBe("killed")
    registry.shutdown()
  })

  it("the subscription profile accepts the configured Claude Code Sonnet", async () => {
    const { host, registry } = setup("reply", "remote-sonnet")
    const res = await host.run(runInput({ spawn: { adapter: "claude-code", model: "claude-sonnet-4-5" } }))
    expect(res.status).toBe("ended")
    registry.shutdown()
  })
})
