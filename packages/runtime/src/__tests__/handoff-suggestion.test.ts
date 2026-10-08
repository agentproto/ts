import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildHandoffSuggestions,
  handoffSuggestionLines,
  listHandoffHarnesses,
  parseHandoffOption,
} from "../handoff-suggestion.js"
import { CONTEXT_CONTINUITY_DEFAULTS, type ResolvedContextContinuityPolicy } from "../context-continuity.js"
import type { AdapterCapabilitiesLister } from "../http-server.js"
import type { RemainingQuotaReader } from "../remaining-quota.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

vi.mock("../session-continue-fresh.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../session-continue-fresh.js")>()
  return { ...mod, continueAgentSessionFresh: vi.fn() }
})

import { continueAgentSessionFresh } from "../session-continue-fresh.js"

const cap = (adapter: string, present: boolean | "no-providers") => ({
  adapter,
  source: "discovered" as const,
  discoverable: "live" as const,
  authStores: [],
  providers:
    present === "no-providers"
      ? []
      : [
          {
            id: adapter,
            billingEndpoint: adapter,
            cred: { present, source: { kind: "env" as const, var: "X" } },
          },
        ],
  models: { mechanism: "free-form" as const },
  endpointCompat: {},
  application: { modelApply: "arg" as const, postureApply: "none" as const, coupled: false },
})

const capabilities: AdapterCapabilitiesLister = async () => [
  cap("claude-code", true),
  cap("codex", true),
  cap("gemini", false),
  cap("pi", "no-providers"),
]

const askPolicy: ResolvedContextContinuityPolicy = {
  ...CONTEXT_CONTINUITY_DEFAULTS,
  mode: "ask",
  warnAtPct: 10,
  compactAtPct: 15,
  continueFreshAtPct: 20,
  hardStopAtPct: 90,
  label: "ask",
}

const collect = (bus: ReturnType<typeof createSessionEventBus>): SessionEvent[] => {
  const seen: SessionEvent[] = []
  bus.on("session:handoff-suggested", e => seen.push(e))
  return seen
}

const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise(r => setTimeout(r, 5))
  }
}

beforeEach(() => {
  vi.mocked(continueAgentSessionFresh).mockReset()
})

describe("handoff-suggestion helpers", () => {
  it("only proposes harnesses with a present credential, never the source harness", async () => {
    expect(await listHandoffHarnesses("claude-code", capabilities)).toEqual(["codex"])
    expect(await listHandoffHarnesses("codex", capabilities)).toEqual(["claude-code"])
  })

  it("proposes nothing without a lister or when the lister throws", async () => {
    expect(await listHandoffHarnesses("claude-code", undefined)).toEqual([])
    expect(
      await listHandoffHarnesses("claude-code", async () => {
        throw new Error("boom")
      }),
    ).toEqual([])
  })

  it("parses handoff:<harness> options", () => {
    expect(parseHandoffOption("handoff:codex")).toBe("codex")
    expect(parseHandoffOption("Handoff:Codex")).toBe("Codex")
    expect(parseHandoffOption("handoff:")).toBeUndefined()
    expect(parseHandoffOption("continue-fresh")).toBeUndefined()
  })

  it("renders the readable line with the command in clear", () => {
    const suggestions = buildHandoffSuggestions("sess_1", ["codex"])
    expect(
      handoffSuggestionLines({
        sessionId: "sess_1",
        fromHarness: "claude-code",
        reason: "provider-limit",
        suggestions,
      }),
    ).toEqual([
      "[handoff] Claude Code hit its usage limit. Hand off to Codex? agentproto sessions handoff sess_1 --to codex",
    ])
  })
})

describe("ask-mode context question offers a handoff", () => {
  const spawnAsking = (opts: { harness?: string; listHarnessCapabilities?: AdapterCapabilitiesLister }) => {
    const reg = createSessionsRegistry({
      persist: false,
      ...(opts.listHarnessCapabilities ? { listHarnessCapabilities: opts.listHarnessCapabilities } : {}),
    })
    const agent: AgentSessionLike = {
      sessionId: "acp-handoff-ask",
      async *send() {
        yield { kind: "usage_update", size: 100, used: 25 }
        yield { kind: "turn-end" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: opts.harness ?? "claude-code",
      contextContinuity: askPolicy,
    })
    return { reg, desc }
  }

  it("adds handoff:<harness> options, current harness excluded", async () => {
    const { reg, desc } = spawnAsking({ listHarnessCapabilities: capabilities })
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.awaitingQuestion).toEqual({
      source: "structured",
      text: "Context is at 25%. Continue fresh to avoid losing continuity?",
      options: ["continue-fresh", "handoff:codex", "keep-going"],
    })
    reg.shutdown()
  })

  it("adds no handoff option when no other harness is eligible", async () => {
    const { reg, desc } = spawnAsking({
      listHarnessCapabilities: async () => [cap("claude-code", true), cap("gemini", false)],
    })
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.awaitingQuestion?.options).toEqual(["continue-fresh", "keep-going"])
    reg.shutdown()
  })

  it("adds no handoff option when no capability lister is wired", async () => {
    const { reg, desc } = spawnAsking({})
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.awaitingQuestion?.options).toEqual(["continue-fresh", "keep-going"])
    reg.shutdown()
  })

  it("answering handoff:codex runs the handoff path with that harness, without a normal turn", async () => {
    vi.mocked(continueAgentSessionFresh).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" },
      checkpoint: { checkpointId: "ckpt_1" },
      continuedFrom: "x",
    } as never)
    const bus = createSessionEventBus()
    const answered: SessionEvent[] = []
    bus.on("session:awaiting-question-answered", e => answered.push(e))
    const reg = createSessionsRegistry({
      persist: false,
      sessionEvents: bus,
      listHarnessCapabilities: capabilities,
      resolveAgentAdapter: async () => null,
    })
    let turns = 0
    const agent: AgentSessionLike = {
      sessionId: "acp-handoff-answer",
      async *send() {
        turns += 1
        yield { kind: "usage_update", size: 100, used: 25 }
        yield { kind: "turn-end" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "claude-code",
      contextContinuity: askPolicy,
    })
    await reg.sendPrompt(desc.id, "go")
    await reg.sendPrompt(desc.id, "handoff:codex")

    expect(turns).toBe(1)
    expect(continueAgentSessionFresh).toHaveBeenCalledOnce()
    const [, prev, opts] = vi.mocked(continueAgentSessionFresh).mock.calls[0]!
    expect(prev.id).toBe(desc.id)
    expect(opts).toMatchObject({ harness: "codex" })
    expect(answered).toEqual([expect.objectContaining({ answer: "handoff:codex" })])
    expect(reg.get(desc.id)?.awaitingInput).toBeFalsy()
    expect(reg.get(desc.id)?.awaitingQuestion).toBeUndefined()
    reg.shutdown()
  })

  it("a handoff:<harness> answer that was never offered is a normal prompt, not a handoff", async () => {
    const { reg, desc } = spawnAsking({ listHarnessCapabilities: capabilities })
    await reg.sendPrompt(desc.id, "go")
    await reg.sendPrompt(desc.id, "handoff:gemini")
    expect(continueAgentSessionFresh).not.toHaveBeenCalled()
    reg.shutdown()
  })
})

describe("provider usage-limit error suggests a handoff", () => {
  it("emits session:handoff-suggested with the command, writes the transcript line, and spawns nothing", async () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    const resolveAgentAdapter = vi.fn(async () => null)
    const reg = createSessionsRegistry({
      persist: false,
      sessionEvents: bus,
      listHarnessCapabilities: capabilities,
      resolveAgentAdapter,
    })
    const agent: AgentSessionLike = {
      sessionId: "acp-limit",
      // eslint-disable-next-line require-yield
      async *send(): AsyncGenerator<never> {
        throw new Error("You've hit your usage limit. Try again in 3 hours.")
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "claude-code",
    })
    const lines: string[] = []
    reg.attach(desc.id, line => {
      lines.push(line)
    })
    await reg.sendPrompt(desc.id, "go")
    await waitFor(() => seen.length > 0)

    expect(reg.get(desc.id)?.endedReason).toBe("provider-limit")
    expect(seen).toEqual([
      expect.objectContaining({
        type: "session:handoff-suggested",
        sessionId: desc.id,
        fromHarness: "claude-code",
        reason: "provider-limit",
        suggestions: [
          { harness: "codex", command: `agentproto sessions handoff ${desc.id} --to codex` },
        ],
      }),
    ])
    expect(lines).toContain(
      `[handoff] Claude Code hit its usage limit. Hand off to Codex? agentproto sessions handoff ${desc.id} --to codex`,
    )
    // Suggestion only: no handoff, no spawn, no adapter resolution.
    expect(continueAgentSessionFresh).not.toHaveBeenCalled()
    expect(resolveAgentAdapter).not.toHaveBeenCalled()
    expect(reg.list().filter(s => s.id !== desc.id)).toEqual([])
    reg.shutdown()
  })

  it("emits nothing when no other harness is eligible", async () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    const reg = createSessionsRegistry({
      persist: false,
      sessionEvents: bus,
      listHarnessCapabilities: async () => [cap("claude-code", true)],
    })
    const agent: AgentSessionLike = {
      sessionId: "acp-limit-alone",
      // eslint-disable-next-line require-yield
      async *send(): AsyncGenerator<never> {
        throw new Error("You've hit your session limit.")
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "claude-code",
    })
    await reg.sendPrompt(desc.id, "go")
    await new Promise(r => setTimeout(r, 30))
    expect(seen).toEqual([])
    reg.shutdown()
  })

  it("an ordinary turn error does not suggest a handoff", async () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    const reg = createSessionsRegistry({
      persist: false,
      sessionEvents: bus,
      listHarnessCapabilities: capabilities,
    })
    const agent: AgentSessionLike = {
      sessionId: "acp-plain-error",
      // eslint-disable-next-line require-yield
      async *send(): AsyncGenerator<never> {
        throw new Error("ENOENT: no such file")
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "claude-code",
    })
    await reg.sendPrompt(desc.id, "go")
    await new Promise(r => setTimeout(r, 30))
    expect(seen).toEqual([])
    reg.shutdown()
  })
})

describe("proactive quota threshold (handoffAtQuotaRemaining)", () => {
  const quotaPolicy: ResolvedContextContinuityPolicy = {
    ...CONTEXT_CONTINUITY_DEFAULTS,
    handoffAtQuotaRemaining: 10,
  }

  const setup = (readings: Array<{ remaining: number; resetsAt: string } | undefined>) => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    const readRemainingQuota = vi.fn(async () => {
      const next = readings.shift()
      return next ? { window: "5h", basis: "provider" as const, ...next } : undefined
    })
    const reader: RemainingQuotaReader = { readRemainingQuota }
    const resolveProfile = vi.fn(async (profileRef: string) => ({
      profileRef,
      endpoint: "anthropic",
      method: "oauth-bearer" as const,
    }))
    const reg = createSessionsRegistry({
      persist: false,
      sessionEvents: bus,
      listHarnessCapabilities: capabilities,
      quotaWatch: { reader, resolveProfile, minIntervalMs: 0 },
    })
    const agent: AgentSessionLike = {
      sessionId: "acp-quota",
      async *send() {
        yield { kind: "turn-end" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "claude-code",
      accessProfile: {
        profileRef: "anthropic-main",
        label: "Main",
        endpoint: "anthropic",
        method: "oauth-bearer",
      },
      contextContinuity: quotaPolicy,
    })
    return { reg, desc, seen, readRemainingQuota }
  }

  it("suggests once per window when remaining falls to the threshold, again for the next window", async () => {
    const { reg, desc, seen } = setup([
      { remaining: 50, resetsAt: "2026-10-02T20:00:00.000Z" },
      { remaining: 10, resetsAt: "2026-10-02T20:00:00.000Z" },
      { remaining: 4, resetsAt: "2026-10-02T20:00:00.000Z" },
      { remaining: 3, resetsAt: "2026-10-03T01:00:00.000Z" },
    ])
    await reg.sendPrompt(desc.id, "1")
    expect(seen).toEqual([])
    await reg.sendPrompt(desc.id, "2")
    await waitFor(() => seen.length === 1)
    expect(seen[0]).toMatchObject({
      type: "session:handoff-suggested",
      reason: "quota-threshold",
      fromHarness: "claude-code",
      suggestions: [{ harness: "codex", command: `agentproto sessions handoff ${desc.id} --to codex` }],
    })
    await reg.sendPrompt(desc.id, "3")
    await new Promise(r => setTimeout(r, 30))
    expect(seen).toHaveLength(1)
    await reg.sendPrompt(desc.id, "4")
    await waitFor(() => seen.length === 2)
    expect(continueAgentSessionFresh).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("is inert without a threshold on the policy", async () => {
    const { reg, desc, seen, readRemainingQuota } = setup([{ remaining: 0, resetsAt: "2026-10-02T20:00:00.000Z" }])
    reg.get(desc.id)!.contextContinuity = CONTEXT_CONTINUITY_DEFAULTS
    await reg.sendPrompt(desc.id, "go")
    await new Promise(r => setTimeout(r, 30))
    expect(readRemainingQuota).not.toHaveBeenCalled()
    expect(seen).toEqual([])
    reg.shutdown()
  })

  it("stays silent when the reader has no value", async () => {
    const { reg, desc, seen } = setup([undefined])
    await reg.sendPrompt(desc.id, "go")
    await new Promise(r => setTimeout(r, 30))
    expect(seen).toEqual([])
    reg.shutdown()
  })
})
