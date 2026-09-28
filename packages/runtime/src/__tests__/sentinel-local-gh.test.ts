/**
 * Unit + integration tests for the `local-gh` sentinel provider (AIP-60 §5).
 *
 * The fake `GhRunner` mirrors exactly what `fetchPrStatus` (review-pr.ts)
 * calls: `repos/{repo}/pulls/{n}`, `.../pulls/{n}/reviews`,
 * `.../commits/{sha}/check-runs` — matched by substring on the last arg
 * (the `gh api ... <path>` invocation), same shape `review-pr.test.ts`
 * presumably already exercises for the plain snapshot fetch.
 */

import { describe, expect, it } from "vitest"
import type { GhRunner } from "../review-pr.js"
import { localGhSentinelProvider, LOCAL_GH_SLUG } from "../sentinel-providers/local-gh.js"
import { singleMatch, type SentinelHandle, type SentinelSpec } from "../sentinel-providers/types.js"
import { createSentinelStore } from "../sentinel-store.js"
import { createSentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import { SessionNotAliveError, type SendMessageResult } from "../sessions.js"
import type { SessionMessage } from "../session-message.js"

// ── Fake gh ──────────────────────────────────────────────────────────

interface FakeGhState {
  number: number
  state: "open" | "closed"
  merged: boolean
  headSha: string
  reviews: Array<{ login: string; state: string; submittedAt: string }>
  checks: Array<{ name: string; conclusion: string | null }>
}

function makeFakeGh(state: FakeGhState): GhRunner {
  return async (args: readonly string[]): Promise<string> => {
    const path = args[args.length - 1] ?? ""
    if (path.includes("/reviews")) {
      return JSON.stringify(
        state.reviews.map(r => ({ user: { login: r.login }, state: r.state, submitted_at: r.submittedAt })),
      )
    }
    if (path.includes("/check-runs")) {
      return JSON.stringify({ check_runs: state.checks.map(c => ({ name: c.name, conclusion: c.conclusion })) })
    }
    if (path.includes("/pulls/")) {
      return JSON.stringify({
        number: state.number,
        state: state.state,
        merged_at: state.merged ? "2026-01-01T00:00:00Z" : null,
        head: { sha: state.headSha },
      })
    }
    throw new Error(`fakeGh: unexpected call ${args.join(" ")}`)
  }
}

const REPO = "acme/widgets"
const SUBJECT = `github:${REPO}#42`

function watchSpec(): SentinelSpec {
  return {
    match: singleMatch(SUBJECT),
    until: { kind: "subject_terminal" },
    target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
    provider: LOCAL_GH_SLUG,
  }
}

// ── Provider unit tests ──────────────────────────────────────────────

describe("localGhSentinelProvider", () => {
  it("rejects create() for a non-PR-shaped subject", async () => {
    const provider = localGhSentinelProvider({ gh: makeFakeGh({ number: 1, state: "open", merged: false, headSha: "s", reviews: [], checks: [] }) })
    await expect(
      provider.create(
        { match: singleMatch("github:acme/widgets"), until: { kind: "never" }, target: { kind: "session", sessionId: "s1", urgency: "next-turn" } },
        { mode: "poll", intervalMs: 15_000 },
      ),
    ).rejects.toThrow(/not a "github:owner\/repo#number" PR subject/)
  })

  it("rejects create() with more than one match clause", async () => {
    const provider = localGhSentinelProvider({ gh: makeFakeGh({ number: 1, state: "open", merged: false, headSha: "s", reviews: [], checks: [] }) })
    await expect(
      provider.create(
        {
          match: [{ subject: SUBJECT }, { subject: "github:acme/other#1" }],
          until: { kind: "never" },
          target: { kind: "session", sessionId: "s1", urgency: "next-turn" },
        },
        { mode: "poll", intervalMs: 15_000 },
      ),
    ).rejects.toThrow(/exactly one match clause/)
  })

  it("first poll establishes a baseline with zero emitted events", async () => {
    const state: FakeGhState = { number: 42, state: "open", merged: false, headSha: "sha1", reviews: [], checks: [] }
    const provider = localGhSentinelProvider({ gh: makeFakeGh(state), nowMs: () => 1_000 })
    const handle = await provider.create(watchSpec(), { mode: "poll", intervalMs: 15_000 })

    const result = await provider.poll!(handle, 50)
    expect(result.events).toEqual([])
    expect(result.cursor).not.toBe(handle.cursor)
  })

  it("a check-run completing produces exactly one check_suite.completed event", async () => {
    const state: FakeGhState = {
      number: 42,
      state: "open",
      merged: false,
      headSha: "sha1",
      reviews: [],
      checks: [{ name: "lint", conclusion: null }],
    }
    const provider = localGhSentinelProvider({ gh: makeFakeGh(state), nowMs: () => 1_000 })
    let handle = await provider.create(watchSpec(), { mode: "poll", intervalMs: 15_000 })

    const baseline = await provider.poll!(handle, 50)
    expect(baseline.events).toEqual([])
    handle = { ...handle, cursor: baseline.cursor }

    state.checks = [{ name: "lint", conclusion: "success" }]
    const after = await provider.poll!(handle, 50)
    expect(after.events).toHaveLength(1)
    expect(after.events[0]!.type).toBe("github.check_suite.completed")
    expect(after.events[0]!.subject).toBe(SUBJECT)
    expect(after.events[0]!.terminal).toBe(false)
    expect(after.events[0]!.data.conclusion).toBe("success")
  })

  it("a new review produces one pull_request_review.submitted event", async () => {
    const state: FakeGhState = { number: 42, state: "open", merged: false, headSha: "sha1", reviews: [], checks: [] }
    const provider = localGhSentinelProvider({ gh: makeFakeGh(state), nowMs: () => 1_000 })
    let handle = await provider.create(watchSpec(), { mode: "poll", intervalMs: 15_000 })
    const baseline = await provider.poll!(handle, 50)
    handle = { ...handle, cursor: baseline.cursor }

    state.reviews = [{ login: "carol", state: "approved", submittedAt: "2026-01-01T00:00:00Z" }]
    const after = await provider.poll!(handle, 50)
    expect(after.events).toHaveLength(1)
    expect(after.events[0]!.type).toBe("github.pull_request_review.submitted")
    expect(after.events[0]!.summary).toContain("carol")
  })

  it("merged -> a terminal pull_request.closed event", async () => {
    const state: FakeGhState = { number: 42, state: "open", merged: false, headSha: "sha1", reviews: [], checks: [] }
    const provider = localGhSentinelProvider({ gh: makeFakeGh(state), nowMs: () => 1_000 })
    let handle = await provider.create(watchSpec(), { mode: "poll", intervalMs: 15_000 })
    const baseline = await provider.poll!(handle, 50)
    handle = { ...handle, cursor: baseline.cursor }

    state.state = "closed"
    state.merged = true
    const after = await provider.poll!(handle, 50)
    expect(after.events).toHaveLength(1)
    expect(after.events[0]!.type).toBe("github.pull_request.closed")
    expect(after.events[0]!.terminal).toBe(true)
    expect(after.events[0]!.data.merged).toBe(true)
  })

  it("a gh failure backs off (no throw, no crash) and is surfaced via status()", async () => {
    const failingGh: GhRunner = async () => {
      throw new Error("network blip")
    }
    let now = 1_000
    const provider = localGhSentinelProvider({ gh: failingGh, nowMs: () => now, backoffBaseMs: 1_000, backoffCapMs: 4_000 })
    let handle = await provider.create(watchSpec(), { mode: "poll", intervalMs: 15_000 })

    const first = await provider.poll!(handle, 50)
    expect(first.events).toEqual([])
    handle = { ...handle, cursor: first.cursor }

    const status1 = await provider.status(handle)
    expect(status1.ok).toBe(false)
    expect(status1.detail).toContain("network blip")

    // Still inside the backoff window at the same instant — poll() must
    // skip calling gh again (cursor round-trips unchanged) rather than
    // throwing or hammering a failing endpoint.
    const second = await provider.poll!(handle, 50)
    expect(second.events).toEqual([])
    expect(second.cursor).toBe(handle.cursor)

    // Advance past the backoff window — poll() tries gh again (still fails,
    // still doesn't throw; failure count increments).
    now += 1_500
    const third = await provider.poll!(handle, 50)
    expect(third.events).toEqual([])
    const status3 = await provider.status({ ...handle, cursor: third.cursor })
    expect(status3.ok).toBe(false)
  })
})

// ── Integration: through the runtime, into a system notice ───────────

interface StubRegistry extends SentinelRuntimeRegistry {
  calls: SessionMessage[]
}
function stubRegistry(impl: (msg: SessionMessage) => Promise<SendMessageResult>): StubRegistry {
  const calls: SessionMessage[] = []
  return {
    calls,
    async sendMessage(msg, _opts) {
      calls.push(msg)
      return impl(msg)
    },
  }
}
const okResult = (): SendMessageResult => ({
  messageId: "msg_test",
  delivered: { via: "turn" },
  queued: false,
  urgencyApplied: "next-turn",
})

describe("local-gh through SentinelRuntime", () => {
  it("a check completing lands a system notice with correlationId sentinel:<subject>, and merging expires the sentinel", async () => {
    const state: FakeGhState = {
      number: 42,
      state: "open",
      merged: false,
      headSha: "sha1",
      reviews: [],
      checks: [{ name: "lint", conclusion: null }],
    }
    const provider = localGhSentinelProvider({ gh: makeFakeGh(state), nowMs: () => 1_000 })
    const store = createSentinelStore({ persist: false })
    const handle = await provider.create(watchSpec(), { mode: "poll", intervalMs: 15_000 })
    const sentinel = store.create({ provider: LOCAL_GH_SLUG, handle, spec: watchSpec() })

    const registry = stubRegistry(async () => okResult())
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: async slug => (slug === LOCAL_GH_SLUG ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
    })

    // Baseline tick — no notice yet.
    await runtime.pollOnce()
    expect(registry.calls).toHaveLength(0)

    // Check completes.
    state.checks = [{ name: "lint", conclusion: "success" }]
    await runtime.pollOnce()
    expect(registry.calls).toHaveLength(1)
    const notice = registry.calls[0]!
    expect(notice.from).toEqual({ relation: "system" })
    expect(notice.kind).toBe("notice")
    expect(notice.correlationId).toBe(`sentinel:${SUBJECT}`)
    expect(notice.text).toContain("[github]")
    expect(store.get(sentinel.id)?.status).toBe("active")

    // Merged — terminal, expires the sentinel.
    state.state = "closed"
    state.merged = true
    await runtime.pollOnce()
    expect(registry.calls).toHaveLength(2)
    expect(registry.calls[1]!.correlationId).toBe(`sentinel:${SUBJECT}`)
    expect(store.get(sentinel.id)?.status).toBe("expired")
  })

  it("a dead, unresumable target session parks the event without crashing the poll loop", async () => {
    const state: FakeGhState = { number: 42, state: "open", merged: false, headSha: "sha1", reviews: [], checks: [] }
    const provider = localGhSentinelProvider({ gh: makeFakeGh(state), nowMs: () => 1_000 })
    const store = createSentinelStore({ persist: false })
    const handle = await provider.create(watchSpec(), { mode: "poll", intervalMs: 15_000 })
    store.create({ provider: LOCAL_GH_SLUG, handle, spec: watchSpec() })

    const registry = stubRegistry(async msg => {
      throw new SessionNotAliveError(msg.to, "error", "sendMessage")
    })
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: async slug => (slug === LOCAL_GH_SLUG ? provider : null),
      isSessionAlive: () => false,
      restartSession: async () => {
        throw new Error("cannot resume")
      },
    })

    await runtime.pollOnce() // baseline, no delivery attempted yet
    state.state = "closed"
    state.merged = true
    await expect(runtime.pollOnce()).resolves.toBeUndefined() // must not throw
  })
})
