import { describe, expect, it, vi } from "vitest"
import { HandoffError, performSessionHandoff } from "../session-handoff.js"
import { ContinueFreshSpawnError } from "../session-continue-fresh.js"
import type { SessionDescriptor } from "../sessions.js"

const mkPrev = (over: Partial<SessionDescriptor> = {}): SessionDescriptor =>
  ({
    id: "sess_old",
    kind: "agent-cli",
    status: "running",
    harness: "claude-code",
    adapterSlug: "claude-code",
    model: "claude-sonnet-5-5",
    label: "brain",
    ...over,
  }) as SessionDescriptor

function setup(prev = mkPrev(), opts: { freshStatus?: string; setModel?: unknown } = {}) {
  const rows = new Map<string, SessionDescriptor>([[prev.id, prev]])
  const kill = vi.fn(() => true)
  const sendPrompt = vi.fn(async () => {})
  const setModel = vi.fn(async () => opts.setModel ?? { applied: true, model: "claude-fable-5-2" })
  const registry = {
    get: (id: string) => rows.get(id),
    kill,
    sendPrompt,
    setModel,
    transferOrchestratorScopes: vi.fn(),
  } as never
  const continueFresh = vi.fn(async (_deps: unknown, p: SessionDescriptor, o: Record<string, unknown>) => {
    const fresh = { id: "sess_new", kind: "agent-cli", status: opts.freshStatus ?? "running", model: o.model } as SessionDescriptor
    rows.set(fresh.id, fresh)
    return { ok: true as const, descriptor: fresh, checkpoint: { checkpointId: "ckpt_1" } as never, continuedFrom: p.id }
  })
  const deps = {
    spawn: { registry, resolveAgentAdapter: vi.fn() } as never,
    continueFresh: continueFresh as never,
    sleep: async () => {},
    pollMs: 1,
    startConfirmTimeoutMs: 5,
    selfCloseDelayMs: 1,
    precheckModel: vi.fn(async (_d: SessionDescriptor, _m: string): Promise<string | undefined> => undefined),
  }
  return { rows, kill, sendPrompt, setModel, continueFresh, deps }
}

describe("session_handoff", () => {
  it("handoff-summary (default): new session, notes carried, source closed after confirmation", async () => {
    const t = setup()
    const r = await performSessionHandoff(t.deps, mkPrev(), { model: "claude-fable-5-2", notes: "next: ship it" })
    expect(r).toMatchObject({ context: "handoff-summary", mode: "new-session", from: "sess_old", to: "sess_new", sourceClosed: true })
    const passed = t.continueFresh.mock.calls[0]![2] as { notes: string; model: string }
    expect(passed.model).toBe("claude-fable-5-2")
    expect(passed.notes).toBe("next: ship it")
    expect(t.kill).toHaveBeenCalledWith("sess_old", "SIGTERM", "restarted")
  })

  it("does NOT close the source when the successor never reaches running", async () => {
    const t = setup(mkPrev(), { freshStatus: "error" })
    const r = await performSessionHandoff(t.deps, mkPrev(), { model: "claude-fable-5-2" })
    expect(r.sourceClosed).toBe(false)
    expect(t.kill).not.toHaveBeenCalled()
    expect(r.warnings.join(" ")).toContain("NOT closed")
  })

  it("closeSource:false leaves the source running", async () => {
    const t = setup()
    const r = await performSessionHandoff(t.deps, mkPrev(), { model: "claude-fable-5-2", closeSource: false })
    expect(r.sourceClosed).toBe(false)
    expect(t.kill).not.toHaveBeenCalled()
  })

  it("self-handoff: never asks the (busy) source, closes it after the result returns", async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      const p = performSessionHandoff({ ...t.deps, callerSessionId: "sess_old" }, mkPrev(), { model: "claude-fable-5-2" })
      const r = await p
      expect((t.continueFresh.mock.calls[0]![2] as { askSource: boolean }).askSource).toBe(false)
      expect(r.selfHandoff).toBe(true)
      expect(r.sourceClosed).toBe(false)
      expect(r.sourceClosePending).toBe(true)
      expect(t.kill).not.toHaveBeenCalled() // deferred
      vi.advanceTimersByTime(5)
      expect(t.kill).toHaveBeenCalledWith("sess_old", "SIGTERM", "restarted")
    } finally {
      vi.useRealTimers()
    }
  })

  it("refuses when nothing would change", async () => {
    const t = setup()
    await expect(performSessionHandoff(t.deps, mkPrev(), { model: "claude-sonnet-5-5" })).rejects.toMatchObject({
      code: "nothing_to_change",
    })
  })

  it("maps a profile/model spawn refusal to the explicit model_refused", async () => {
    const t = setup()
    t.continueFresh.mockRejectedValueOnce(new ContinueFreshSpawnError("access_profile_ineligible", "profile x refuses model y"))
    const err = await performSessionHandoff(t.deps, mkPrev(), { model: "y" }).catch(e => e)
    expect(err).toBeInstanceOf(HandoffError)
    expect(err.code).toBe("model_refused")
    expect(t.kill).not.toHaveBeenCalled()
  })

  it("none: switches the model in place, no new session, no kill", async () => {
    const t = setup()
    const r = await performSessionHandoff(t.deps, mkPrev(), { context: "none", model: "claude-fable-5-2" })
    expect(r).toMatchObject({ mode: "in-place", to: "sess_old", sourceClosed: false })
    expect(t.setModel).toHaveBeenCalledWith("sess_old", "claude-fable-5-2")
    expect(t.continueFresh).not.toHaveBeenCalled()
  })

  it("none: refuses a harness change", async () => {
    const t = setup()
    await expect(
      performSessionHandoff(t.deps, mkPrev(), { context: "none", harness: "codex", model: "gpt-x" }),
    ).rejects.toMatchObject({ code: "harness_change_needs_new_session" })
  })

  it("none: pre-check refusal stops before touching the session", async () => {
    const t = setup()
    t.deps.precheckModel.mockResolvedValueOnce("profile p does not allow model y")
    await expect(performSessionHandoff(t.deps, mkPrev(), { context: "none", model: "y" })).rejects.toMatchObject({
      code: "model_refused",
    })
    expect(t.setModel).not.toHaveBeenCalled()
  })

  it("none: a harness that can't switch live reports in_place_not_supported (no silent fallback)", async () => {
    const t = setup(mkPrev(), { setModel: { applied: false, reason: "requires-restart" } })
    await expect(performSessionHandoff(t.deps, mkPrev(), { context: "none", model: "y" })).rejects.toMatchObject({
      code: "in_place_not_supported",
    })
    expect(t.continueFresh).not.toHaveBeenCalled()
  })

  it("harness-compact (same harness): /compact, wait idle, then model switch in place", async () => {
    const t = setup()
    const r = await performSessionHandoff(t.deps, mkPrev(), { context: "harness-compact", model: "claude-fable-5-2" })
    // operator call (no caller session): source-less, so the operator's agreement counts
    expect(t.sendPrompt).toHaveBeenCalledWith("sess_old", "/compact", undefined)
    expect(t.setModel).toHaveBeenCalled()
    expect(r).toMatchObject({ mode: "in-place", compacted: true })
  })

  it("harness-compact called by a parent session keeps the agent: source", async () => {
    const t = setup()
    await performSessionHandoff({ ...t.deps, callerSessionId: "sess_parent" }, mkPrev(), {
      context: "harness-compact",
      model: "claude-fable-5-2",
    })
    expect(t.sendPrompt).toHaveBeenCalledWith("sess_old", "/compact", { source: "agent:sess_parent" })
  })

  it("harness-compact refuses when the harness advertises commands but not /compact", async () => {
    const prev = mkPrev({ availableCommands: [{ name: "clear" }] } as never)
    const t = setup(prev)
    await expect(performSessionHandoff(t.deps, prev, { context: "harness-compact", model: "m2" })).rejects.toMatchObject({
      code: "compact_failed",
    })
    expect(t.sendPrompt).not.toHaveBeenCalled()
    expect(t.setModel).not.toHaveBeenCalled()
  })

  it("harness-compact on hermes sends /compress", async () => {
    const hermes = mkPrev({ harness: "hermes", adapterSlug: "hermes" })
    const t = setup(hermes)
    await performSessionHandoff(t.deps, hermes, { context: "harness-compact", model: "m2" })
    expect(t.sendPrompt).toHaveBeenCalledWith("sess_old", "/compress", undefined)
  })

  it("harness-compact + harness change: compacts, then a summary handoff", async () => {
    const t = setup()
    const r = await performSessionHandoff(t.deps, mkPrev(), { context: "harness-compact", harness: "codex", model: "gpt-x" })
    expect(r).toMatchObject({ mode: "new-session", compacted: true, fellBackTo: "handoff-summary", to: "sess_new" })
  })

  it("harness-compact from the caller itself is refused (compact only runs after the turn)", async () => {
    const t = setup()
    await expect(
      performSessionHandoff({ ...t.deps, callerSessionId: "sess_old" }, mkPrev(), { context: "harness-compact", model: "m2" }),
    ).rejects.toMatchObject({ code: "compact_from_self" })
  })

})
