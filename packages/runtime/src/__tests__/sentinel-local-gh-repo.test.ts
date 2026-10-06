/**
 * Repo-scope `local-gh` sentinel: one watch over EVERY PR of a repo
 * (`github:owner/repo`), fed by one GraphQL call per tick.
 */

import { describe, expect, it } from "vitest"
import type { GhRunner } from "../review-pr.js"
import { localGhSentinelProvider, LOCAL_GH_SLUG } from "../sentinel-providers/local-gh.js"
import { singleMatch, type SentinelHandle, type SentinelSpec } from "../sentinel-providers/types.js"
import { createSentinelStore } from "../sentinel-store.js"
import { createSentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import type { SendMessageResult } from "../sessions.js"
import type { SessionMessage } from "../session-message.js"

interface FakePr {
  number: number
  title: string
  state: "OPEN" | "MERGED" | "CLOSED"
  isDraft: boolean
  createdAt: string
  headRefOid: string
  author: string
  reviews: Array<{ login: string; state: string; submittedAt: string }>
  checks: Array<{ name: string; conclusion: string | null }>
}

const REPO = "acme/widgets"
const REPO_SUBJECT = `github:${REPO}`

function pr(number: number, over: Partial<FakePr> = {}): FakePr {
  return {
    number,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-10-05T10:00:00Z",
    headRefOid: `sha${number}`,
    author: "alice",
    reviews: [],
    checks: [],
    ...over,
  }
}

function fakeGh(prs: FakePr[], calls?: string[][]): GhRunner {
  return async args => {
    calls?.push([...args])
    if (args[0] !== "api" || args[1] !== "graphql") throw new Error(`fakeGh: unexpected ${args.join(" ")}`)
    return JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            nodes: prs.map(p => ({
              number: p.number,
              title: p.title,
              url: `https://github.com/${REPO}/pull/${p.number}`,
              isDraft: p.isDraft,
              state: p.state,
              createdAt: p.createdAt,
              headRefOid: p.headRefOid,
              author: { login: p.author },
              reviews: {
                nodes: p.reviews.map(r => ({ author: { login: r.login }, state: r.state, submittedAt: r.submittedAt })),
              },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: p.checks.map(c => ({
                            __typename: "CheckRun",
                            name: c.name,
                            status: c.conclusion === null ? "IN_PROGRESS" : "COMPLETED",
                            conclusion: c.conclusion === null ? null : c.conclusion.toUpperCase(),
                          })),
                        },
                      },
                    },
                  },
                ],
              },
            })),
          },
        },
      },
    })
  }
}

function repoSpec(until: SentinelSpec["until"] = { kind: "never" }): SentinelSpec {
  return {
    match: singleMatch(REPO_SUBJECT),
    until,
    target: { kind: "session", sessionId: "sess_brain", urgency: "next-turn" },
    provider: LOCAL_GH_SLUG,
  }
}

const DELIVERY = { mode: "poll", intervalMs: 15_000 } as const

async function step(
  provider: ReturnType<typeof localGhSentinelProvider>,
  handle: SentinelHandle,
): Promise<{ handle: SentinelHandle; types: string[]; events: Awaited<ReturnType<NonNullable<typeof provider.poll>>>["events"] }> {
  const r = await provider.poll!(handle, 50)
  return { handle: { ...handle, cursor: r.cursor }, types: r.events.map(e => `${e.type}#${e.subject.split("#")[1]}`), events: r.events }
}

describe("local-gh repo scope", () => {
  it("accepts a bare repo subject only with until:never, and defaults to verdict-level types", async () => {
    const provider = localGhSentinelProvider({ gh: fakeGh([]) })
    await expect(provider.create(repoSpec({ kind: "subject_terminal" }), DELIVERY)).rejects.toThrow(/until "never"/)
    const handle = await provider.create(repoSpec(), DELIVERY)
    expect(handle.state).toEqual({ repo: REPO })
    expect(provider.defaultTypes(REPO_SUBJECT)).toEqual(
      expect.arrayContaining([
        "github.pull_request.opened",
        "github.pull_request.ready_for_review",
        "github.check_suite.completed",
        "github.pull_request_review.submitted",
        "github.pull_request.closed",
      ]),
    )
    expect(provider.defaultTypes(REPO_SUBJECT)).not.toContain("github.pull_request.synchronize")
  })

  it("the baseline poll is silent and costs one gh call", async () => {
    const calls: string[][] = []
    const prs = [pr(1), pr(2, { state: "MERGED" }), pr(3, { checks: [{ name: "ci", conclusion: "success" }] })]
    const provider = localGhSentinelProvider({ gh: fakeGh(prs, calls), nowMs: () => Date.parse("2026-10-05T12:00:00Z") })
    const handle = await provider.create(repoSpec(), DELIVERY)
    const first = await step(provider, handle)
    expect(first.types).toEqual([])
    expect(calls).toHaveLength(1)
    const second = await step(provider, first.handle)
    expect(second.types).toEqual([])
  })

  it("reports a new PR, draft -> ready, the CI verdict once per head, a review, and the merge", async () => {
    let now = Date.parse("2026-10-05T12:00:00Z")
    const prs: FakePr[] = [pr(1, { createdAt: "2026-10-01T00:00:00Z" })]
    const provider = localGhSentinelProvider({ gh: fakeGh(prs), nowMs: () => now })
    let handle = await provider.create(repoSpec(), DELIVERY)
    handle = (await step(provider, handle)).handle

    now += 60_000
    prs.push(pr(2, { isDraft: true, createdAt: "2026-10-05T12:00:30Z", checks: [{ name: "lint", conclusion: null }] }))
    let r = await step(provider, handle)
    handle = r.handle
    expect(r.types).toEqual(["github.pull_request.opened#2"])
    expect(r.events[0]!.summary).toContain("(draft)")
    expect(r.events[0]!.data).toMatchObject({ title: "PR 2", author: "alice", draft: true })

    now += 60_000
    prs[1]!.isDraft = false
    r = await step(provider, handle)
    handle = r.handle
    expect(r.types).toEqual(["github.pull_request.ready_for_review#2"])

    // CI: still running -> silent; one check fails -> verdict now, not at the end.
    now += 60_000
    prs[1]!.checks = [
      { name: "lint", conclusion: "failure" },
      { name: "test", conclusion: null },
    ]
    r = await step(provider, handle)
    handle = r.handle
    expect(r.types).toEqual(["github.check_suite.completed#2"])
    expect(r.events[0]!.data).toMatchObject({ conclusion: "failure", failed: ["lint"] })

    now += 60_000
    prs[1]!.checks = [
      { name: "lint", conclusion: "failure" },
      { name: "test", conclusion: "success" },
    ]
    r = await step(provider, handle)
    handle = r.handle
    expect(r.types).toEqual([])

    // New head, green -> a fresh verdict.
    now += 60_000
    prs[1]!.headRefOid = "sha2b"
    prs[1]!.checks = [{ name: "lint", conclusion: "success" }]
    r = await step(provider, handle)
    handle = r.handle
    expect(r.types).toEqual(["github.check_suite.completed#2"])
    expect(r.events[0]!.data).toMatchObject({ conclusion: "success" })

    now += 60_000
    prs[1]!.reviews = [{ login: "bob", state: "APPROVED", submittedAt: "2026-10-05T12:09:00Z" }]
    r = await step(provider, handle)
    handle = r.handle
    expect(r.types).toEqual(["github.pull_request_review.submitted#2"])

    now += 60_000
    prs[1]!.state = "MERGED"
    r = await step(provider, handle)
    handle = r.handle
    expect(r.types).toEqual(["github.pull_request.closed#2"])
    expect(r.events[0]!.terminal).toBe(true)

    // The merged PR stays in the listing: no replay of its reviews/closure.
    now += 60_000
    r = await step(provider, handle)
    expect(r.types).toEqual([])
  })

  it("does not announce PRs that predate the watch, even when they fall out of the stored set", async () => {
    let now = Date.parse("2026-10-05T12:00:00Z")
    const prs: FakePr[] = [pr(1, { createdAt: "2026-09-01T00:00:00Z" })]
    const provider = localGhSentinelProvider({ gh: fakeGh(prs), nowMs: () => now })
    let handle = await provider.create(repoSpec(), DELIVERY)
    handle = (await step(provider, handle)).handle
    now += 60_000
    prs.push(pr(7, { createdAt: "2026-08-01T00:00:00Z", state: "MERGED" }))
    expect((await step(provider, handle)).types).toEqual([])
  })

  it("a PR opened and merged between two ticks yields opened + closed", async () => {
    let now = Date.parse("2026-10-05T12:00:00Z")
    const prs: FakePr[] = []
    const provider = localGhSentinelProvider({ gh: fakeGh(prs), nowMs: () => now })
    let handle = await provider.create(repoSpec(), DELIVERY)
    handle = (await step(provider, handle)).handle
    now += 60_000
    prs.push(pr(9, { createdAt: "2026-10-05T12:00:20Z", state: "MERGED" }))
    const r = await step(provider, handle)
    expect(r.types).toEqual(["github.pull_request.opened#9", "github.pull_request.closed#9"])
  })

  it("a gh failure backs off without losing the known PRs", async () => {
    let now = Date.parse("2026-10-05T12:00:00Z")
    const prs: FakePr[] = [pr(1)]
    let fail = false
    const inner = fakeGh(prs)
    const provider = localGhSentinelProvider({
      gh: async args => {
        if (fail) throw new Error("rate limited")
        return inner(args)
      },
      nowMs: () => now,
    })
    let handle = await provider.create(repoSpec(), DELIVERY)
    handle = (await step(provider, handle)).handle
    fail = true
    now += 60_000
    handle = (await step(provider, handle)).handle
    expect(await provider.status!(handle)).toMatchObject({ ok: false })
    fail = false
    now += 10 * 60_000
    prs.push(pr(2, { createdAt: "2026-10-05T12:05:00Z" }))
    expect((await step(provider, handle)).types).toEqual(["github.pull_request.opened#2"])
  })
})

describe("repo-scope watch through SentinelRuntime", () => {
  it("delivers each PR's events to the watcher and stays active after merges", async () => {
    let now = Date.parse("2026-10-05T12:00:00Z")
    const prs: FakePr[] = []
    const provider = localGhSentinelProvider({ gh: fakeGh(prs), nowMs: () => now })
    const store = createSentinelStore({ persist: false })
    const handle = await provider.create(repoSpec(), DELIVERY)
    const sentinel = store.create({ provider: LOCAL_GH_SLUG, handle, spec: repoSpec() })
    const sent: SessionMessage[] = []
    const registry = {
      async sendMessage(msg: SessionMessage): Promise<SendMessageResult> {
        sent.push(msg)
        return { delivered: true } as unknown as SendMessageResult
      },
    } as unknown as SentinelRuntimeRegistry
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: async slug => (slug === LOCAL_GH_SLUG ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
    })

    await runtime.pollOnce() // baseline
    now += 60_000
    prs.push(pr(5, { createdAt: "2026-10-05T12:00:10Z" }), pr(6, { createdAt: "2026-10-05T12:00:20Z" }))
    await runtime.pollOnce()
    expect(sent.map(m => m.correlationId)).toEqual([`sentinel:${REPO_SUBJECT}#5`, `sentinel:${REPO_SUBJECT}#6`])

    now += 60_000
    prs[0]!.state = "MERGED"
    prs[1]!.state = "CLOSED"
    await runtime.pollOnce()
    expect(sent).toHaveLength(4)
    expect(store.get(sentinel.id)?.status).toBe("active")
  })
})
