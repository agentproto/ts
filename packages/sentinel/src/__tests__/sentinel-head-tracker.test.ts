/**
 * Superseded-head marking: a CI event about a commit that is no longer the
 * PR head is marked (`data.stale`, `data.current_head_sha`, `[superseded]`
 * summary) and delivered at `fyi`, never dropped; the current head, an
 * unknown head and non-CI events are untouched.
 */

import { registerGithubDeliveryModule } from "@agentproto/delivery-github"
import { describe, expect, it } from "vitest"

import { normalizeGithubEvent } from "../sentinel-github-normalize.js"
import {
  PR_HEADS_CAP,
  SUPERSEDED_SHAS_CAP,
  isStaleCiEvent,
  trackHead,
  type PrHeads,
} from "../sentinel-head-tracker.js"
import { createSentinelRuntime } from "../sentinel-runtime.js"
import { createSentinelStore } from "../sentinel-store.js"
import { createFakeSentinelProvider } from "../sentinel-providers/fake.js"
import type { SentinelEvent } from "../sentinel-providers/types.js"
import type { SendMessageResult, SessionMessage } from "../local-types.js"
import { registerSentinelClassifier, registerSentinelRepeatKey } from "../sentinel-triage.js"
import { registerSentinelCoalesceRule } from "../sentinel-coalesce.js"
import { classifySentinelEvent, RecentKeys } from "../sentinel-triage.js"

registerGithubDeliveryModule({
  registerClassifier: registerSentinelClassifier,
  registerCoalesceRule: registerSentinelCoalesceRule,
  registerRepeatKey: registerSentinelRepeatKey,
})

const SUBJECT = "github:acme/widgets#42"
const OLD = "178f5940000000000000000000000000000000aa"
const NEW = "4ad5ca90000000000000000000000000000000bb"

const repository = { name: "widgets", owner: { login: "acme" } }

function normalized(event: string, deliveryId: string, payload: Record<string, unknown>): SentinelEvent {
  const result = normalizeGithubEvent({ event, deliveryId, payload })
  if (!result.ok) throw new Error(result.reason)
  return result.event as SentinelEvent
}

const prEvent = (action: string, sha: string, id = `pr-${action}-${sha.slice(0, 4)}`, before?: string) =>
  normalized("pull_request", id, {
    action,
    ...(before ? { before } : {}),
    repository,
    pull_request: { number: 42, title: "t", html_url: "u", head: { sha }, user: { login: "dev" } },
    sender: { login: "dev" },
  })

const suiteCompleted = (sha: string, conclusion = "failure", id = `suite-${sha.slice(0, 4)}`) =>
  normalized("check_suite", id, {
    action: "completed",
    repository,
    check_suite: { conclusion, head_sha: sha, head_branch: "feat", pull_requests: [{ number: 42 }], app: { name: "GitHub Actions" } },
  })

const runCompleted = (sha: string, conclusion = "failure", id = `run-${sha.slice(0, 4)}`) =>
  normalized("workflow_run", id, {
    action: "completed",
    repository,
    workflow_run: { name: "CI", conclusion, head_sha: sha, head_branch: "feat", pull_requests: [{ number: 42 }] },
  })

const reviewEvent = () =>
  normalized("pull_request_review", "rev-1", {
    action: "submitted",
    repository,
    pull_request: { number: 42 },
    review: { state: "changes_requested", user: { login: "rev" } },
  })

describe("trackHead (pure)", () => {
  it("records the head from pull_request opened/synchronize/reopened", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      const { heads, event } = trackHead(prEvent(action, NEW), {})
      expect(heads).toEqual({ [SUBJECT]: { head: NEW, superseded: [] } })
      expect(isStaleCiEvent(event)).toBe(false)
    }
  })

  it("synchronize keeps the payload's before in data and records it as superseded", () => {
    const sync = prEvent("synchronize", NEW, "sync-1", OLD)
    expect(sync.data.before).toBe(OLD)
    expect(trackHead(sync, {}).heads).toEqual({ [SUBJECT]: { head: NEW, superseded: [OLD] } })
  })

  it("a head change supersedes the previously recorded head; an unchanged head returns no update", () => {
    expect(trackHead(prEvent("synchronize", NEW), { [SUBJECT]: { head: OLD, superseded: [] } }).heads).toEqual({
      [SUBJECT]: { head: NEW, superseded: [OLD] },
    })
    expect(trackHead(prEvent("synchronize", NEW), { [SUBJECT]: { head: NEW, superseded: [] } }).heads).toBeUndefined()
  })

  it("a force-push back to a superseded sha makes it the head again", () => {
    const heads = { [SUBJECT]: { head: NEW, superseded: [OLD] } }
    expect(trackHead(prEvent("synchronize", OLD, "back", NEW), heads).heads).toEqual({
      [SUBJECT]: { head: OLD, superseded: [NEW] },
    })
  })

  it("leaves a CI event for the current head unchanged", () => {
    const suite = suiteCompleted(NEW)
    const out = trackHead(suite, { [SUBJECT]: { head: NEW, superseded: [OLD] } })
    expect(out.event).toBe(suite)
    expect(out.heads).toBeUndefined()
  })

  it("marks a CI event for a known superseded sha: stale, current_head_sha, [superseded], levelHint 1, never terminal", () => {
    for (const ci of [suiteCompleted(OLD), runCompleted(OLD)]) {
      const { event } = trackHead(ci, { [SUBJECT]: { head: NEW, superseded: [OLD] } })
      expect(event.data.stale).toBe(true)
      expect(event.data.current_head_sha).toBe(NEW)
      expect(event.data.head_sha).toBe(OLD)
      expect(event.summary).toBe(`[superseded] ${ci.summary}`)
      expect(event.levelHint).toBe(1)
      expect(event.terminal).toBe(false)
      expect(event.id).toBe(ci.id)
    }
  })

  it("old head after synchronize is marked", () => {
    const { heads } = trackHead(prEvent("synchronize", NEW, "s", OLD), { [SUBJECT]: { head: OLD, superseded: [] } })
    expect(trackHead(suiteCompleted(OLD), heads).event.data.stale).toBe(true)
  })

  it("before alone is enough to mark (the old head was never seen as a head)", () => {
    const { heads } = trackHead(prEvent("synchronize", NEW, "s", OLD), undefined)
    const { event } = trackHead(suiteCompleted(OLD), heads)
    expect(event.data.stale).toBe(true)
    expect(event.data.current_head_sha).toBe(NEW)
  })

  it("a CI event for a sha never seen is not marked, even when a different head is known (out-of-order delivery)", () => {
    // The new head's CI finishes before its synchronize arrives: head is still OLD.
    const suite = suiteCompleted(NEW)
    expect(trackHead(suite, { [SUBJECT]: { head: OLD, superseded: [] } }).event).toBe(suite)
  })

  it("does not mark when nothing is known about the PR (fail open)", () => {
    const suite = suiteCompleted(OLD)
    expect(trackHead(suite, undefined).event).toBe(suite)
    expect(trackHead(suite, {}).event).toBe(suite)
    expect(trackHead(suite, { "github:acme/widgets#7": { head: NEW, superseded: [OLD] } }).event).toBe(suite)
  })

  it("does not mark a CI event that carries no sha, or a non-CI event", () => {
    const heads = { [SUBJECT]: { head: NEW, superseded: [OLD] } }
    const noSha = { ...suiteCompleted(OLD), data: { action: "completed", conclusion: "failure" } }
    expect(trackHead(noSha, heads).event).toBe(noSha)
    const review = reviewEvent()
    expect(trackHead(review, heads).event).toBe(review)
  })

  it("does not mark twice", () => {
    const heads = { [SUBJECT]: { head: NEW, superseded: [OLD] } }
    const once = trackHead(suiteCompleted(OLD), heads).event
    expect(trackHead(once, heads).event).toBe(once)
  })

  it("matches an abbreviated sha as the same commit", () => {
    const heads = { [SUBJECT]: { head: NEW, superseded: [OLD] } }
    const current = suiteCompleted(NEW.slice(0, 7))
    expect(trackHead(current, heads).event).toBe(current)
    expect(trackHead(suiteCompleted(OLD.slice(0, 7)), heads).event.data.stale).toBe(true)
  })

  it("the terminal event (PR closed/merged) removes the subject's entry", () => {
    const heads = { [SUBJECT]: { head: NEW, superseded: [OLD] }, "github:acme/widgets#7": { head: OLD, superseded: [] } }
    expect(trackHead(prEvent("closed", NEW), heads).heads).toEqual({ "github:acme/widgets#7": { head: OLD, superseded: [] } })
    expect(trackHead(prEvent("closed", NEW), {}).heads).toBeUndefined()
  })

  it("caps the remembered PRs and the superseded shas per PR, evicting the oldest", () => {
    let heads: PrHeads = {}
    for (let n = 0; n < PR_HEADS_CAP + 5; n++) {
      const ev = { ...prEvent("synchronize", NEW, `pr-${n}`), subject: `github:acme/widgets#${n}` }
      heads = trackHead(ev, heads).heads ?? heads
    }
    expect(Object.keys(heads)).toHaveLength(PR_HEADS_CAP)
    expect(heads["github:acme/widgets#0"]).toBeUndefined()

    let one: PrHeads = {}
    for (let n = 0; n < SUPERSEDED_SHAS_CAP + 5; n++) {
      one = trackHead(prEvent("synchronize", `${n}`.padStart(40, "a"), `p${n}`), one).heads ?? one
    }
    expect(one[SUBJECT]!.superseded).toHaveLength(SUPERSEDED_SHAS_CAP)
  })

  it("triage ranks a superseded failure fyi, never wake or terminal", () => {
    const marked = trackHead(suiteCompleted(OLD), { [SUBJECT]: { head: NEW, superseded: [OLD] } }).event
    expect(classifySentinelEvent(marked, { target: "s", sentinelId: "x", now: 0, recent: new RecentKeys() })).toEqual({
      decision: "fyi",
      rule: "superseded",
    })
  })
})

// ── Runtime: the shared pipeline webhook and agentpush converge on ────

const okResult = (): SendMessageResult =>
  ({ messageId: "msg", delivered: { via: "turn" }, queued: false, urgencyApplied: "next-turn" }) as never

function setup(types: string[] = ["github.*"]) {
  const store = createSentinelStore({ persist: false })
  const provider = createFakeSentinelProvider()
  const sent: SessionMessage[] = []
  const sentinel = store.create({
    provider: "fake",
    handle: { provider: "fake" },
    spec: {
      match: [{ subject: SUBJECT, types }],
      until: { kind: "subject_terminal" },
      target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
      provider: "fake",
    },
  })
  const runtime = createSentinelRuntime({
    store,
    registry: {
      async sendMessage(msg: SessionMessage) {
        sent.push(msg)
        return okResult()
      },
    },
    resolveProvider: async slug => (slug === provider.slug ? provider : null),
    isSessionAlive: () => true,
    restartSession: async id => id,
  })
  return { store, sentinel, runtime, sent }
}

describe("runtime superseded-head marking", () => {
  it("a push, then the old suite's completion arrives: marked, delivered at fyi, not lost", async () => {
    const { store, sentinel, runtime, sent } = setup()
    // #2732's shape: 178f594 is the `before` of the 4ad5ca9 synchronize.
    await runtime.deliverPushed(sentinel.id, [prEvent("synchronize", NEW, "sync", OLD)])
    await runtime.deliverPushed(sentinel.id, [suiteCompleted(OLD), runCompleted(OLD)])

    expect(store.get(sentinel.id)?.prHeads).toEqual({ [SUBJECT]: { head: NEW, superseded: [OLD] } })
    const ci = sent.slice(1)
    expect(ci).toHaveLength(2)
    for (const msg of ci) {
      expect(msg.urgency).toBe("fyi")
      expect(msg.text).toMatch(/^\[github\] \[superseded\] /)
      expect((msg.data as { data: Record<string, unknown> }).data).toMatchObject({ stale: true, current_head_sha: NEW })
    }
    expect(store.get(sentinel.id)?.status).toBe("active")
  })

  it("the same batch order works too (push and stale completion in one delivery)", async () => {
    const { sentinel, runtime, sent } = setup()
    await runtime.deliverPushed(sentinel.id, [prEvent("synchronize", NEW, "sync", OLD), suiteCompleted(OLD)])
    expect(sent.map(m => m.urgency)).toEqual(["next-turn", "fyi"])
  })

  it("the new head's CI arriving before its synchronize stays unmarked, at the target urgency", async () => {
    const { sentinel, runtime, sent } = setup()
    await runtime.deliverPushed(sentinel.id, [prEvent("opened", OLD)])
    await runtime.deliverPushed(sentinel.id, [suiteCompleted(NEW)])
    await runtime.deliverPushed(sentinel.id, [prEvent("synchronize", NEW, "sync", OLD)])
    expect(sent[1]!.urgency).toBe("next-turn")
    expect(sent[1]!.text).not.toContain("[superseded]")
  })

  it("learns heads from pull_request events the per-clause types filter drops", async () => {
    const { store, sentinel, runtime, sent } = setup(["github.check_suite.*"])
    await runtime.deliverPushed(sentinel.id, [prEvent("synchronize", NEW, "sync", OLD), suiteCompleted(OLD)])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.urgency).toBe("fyi")
    expect(store.get(sentinel.id)?.prHeads?.[SUBJECT]?.head).toBe(NEW)
  })

  it("the PR's terminal event clears its head state", async () => {
    const { store, sentinel, runtime } = setup()
    await runtime.deliverPushed(sentinel.id, [prEvent("synchronize", NEW, "sync", OLD), prEvent("closed", NEW)])
    expect(store.get(sentinel.id)?.prHeads).toEqual({})
  })

  it("a CI event for the current head is delivered unchanged at the target urgency", async () => {
    const { sentinel, runtime, sent } = setup()
    await runtime.deliverPushed(sentinel.id, [prEvent("synchronize", NEW, "sync", OLD), suiteCompleted(NEW)])
    const msg = sent[1]!
    expect(msg.urgency).toBe("next-turn")
    expect(msg.text).not.toContain("[superseded]")
    expect((msg.data as { data: Record<string, unknown> }).data.stale).toBeUndefined()
  })

  it("an unknown head (no pull_request event seen) is not marked", async () => {
    const { store, sentinel, runtime, sent } = setup()
    await runtime.deliverPushed(sentinel.id, [suiteCompleted(OLD)])
    expect(sent[0]!.urgency).toBe("next-turn")
    expect(sent[0]!.text).not.toContain("[superseded]")
    expect(store.get(sentinel.id)?.prHeads).toBeUndefined()
  })
})
