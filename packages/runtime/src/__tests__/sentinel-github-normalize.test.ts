/**
 * Fixture tests for the GitHub webhook -> CloudEvents normalizer (AIP-60 §4).
 *
 * Fixtures are trimmed to the fields the normalizer actually reads — a real
 * GitHub payload carries far more, but asserting against the full shape
 * would just make the fixture noisy without exercising anything new.
 */

import { describe, expect, it } from "vitest"
import { GITHUB_DEFAULT_PR_TYPES, normalizeGithubEvent } from "../sentinel-github-normalize.js"

const TIME = "2026-09-27T14:03:11.000Z"

describe("normalizeGithubEvent", () => {
  it("normalizes a merged pull_request.closed as terminal, with the PR/repo/owner subject hierarchy", () => {
    const result = normalizeGithubEvent({
      event: "pull_request",
      deliveryId: "d1",
      time: TIME,
      payload: {
        action: "closed",
        number: 1428,
        pull_request: {
          number: 1428,
          title: "feat(inbox): …",
          html_url: "https://github.com/agentproto/ts/pull/1428",
          merged: true,
          head: { sha: "abc123" },
        },
        repository: { full_name: "agentproto/ts" },
        sender: { login: "jeremy" },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event).toEqual({
      specversion: "1.0",
      id: "evt_d1",
      source: "//agentproto.local/sentinel/github",
      type: "github.pull_request.closed",
      subject: "github:agentproto/ts#1428",
      time: TIME,
      datacontenttype: "application/json",
      data: {
        action: "closed",
        merged: true,
        repo: "agentproto/ts",
        number: 1428,
        title: "feat(inbox): …",
        url: "https://github.com/agentproto/ts/pull/1428",
        actor: "jeremy",
        head_sha: "abc123",
      },
      summary: "PR agentproto/ts#1428 merged by jeremy",
      subjects: ["github:agentproto/ts#1428", "github:agentproto/ts", "github:agentproto"],
      terminal: true,
    })
  })

  it("normalizes a non-merged pull_request.closed as closed (not merged), still terminal", () => {
    const result = normalizeGithubEvent({
      event: "pull_request",
      deliveryId: "d2",
      time: TIME,
      payload: {
        action: "closed",
        pull_request: { number: 7, merged: false },
        repository: { full_name: "acme/widgets" },
        sender: { login: "alice" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.summary).toBe("PR acme/widgets#7 closed by alice")
    expect(result.event.terminal).toBe(true)
    expect(result.event.data.merged).toBe(false)
  })

  it("normalizes pull_request.opened as non-terminal", () => {
    const result = normalizeGithubEvent({
      event: "pull_request",
      deliveryId: "d3",
      payload: {
        action: "opened",
        pull_request: { number: 3 },
        repository: { full_name: "acme/widgets" },
        sender: { login: "bob" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.type).toBe("github.pull_request.opened")
    expect(result.event.terminal).toBe(false)
    expect(result.event.summary).toBe("PR acme/widgets#3 opened by bob")
  })

  it("normalizes pull_request_review.submitted", () => {
    const result = normalizeGithubEvent({
      event: "pull_request_review",
      deliveryId: "d4",
      payload: {
        action: "submitted",
        pull_request: { number: 42 },
        review: { state: "approved", user: { login: "carol" } },
        repository: { full_name: "acme/widgets" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.type).toBe("github.pull_request_review.submitted")
    expect(result.event.subject).toBe("github:acme/widgets#42")
    expect(result.event.summary).toBe("PR acme/widgets#42 review approved by carol")
    expect(result.event.terminal).toBe(false)
  })

  it("normalizes check_suite.completed against its PR when pull_requests[] is non-empty", () => {
    const result = normalizeGithubEvent({
      event: "check_suite",
      deliveryId: "d5",
      payload: {
        action: "completed",
        check_suite: { conclusion: "success", pull_requests: [{ number: 9 }] },
        repository: { full_name: "acme/widgets" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.type).toBe("github.check_suite.completed")
    expect(result.event.subject).toBe("github:acme/widgets#9")
    expect(result.event.subjects).toEqual(["github:acme/widgets#9", "github:acme/widgets", "github:acme"])
    expect(result.event.summary).toBe("Check suite success for acme/widgets#9")
    expect(result.event.data.number).toBe(9)
  })

  it("falls back to the repo subject + head_branch when check_suite has no linked PR", () => {
    const result = normalizeGithubEvent({
      event: "check_suite",
      deliveryId: "d6",
      payload: {
        action: "completed",
        check_suite: { conclusion: "failure", pull_requests: [], head_branch: "main" },
        repository: { full_name: "acme/widgets" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.subject).toBe("github:acme/widgets")
    expect(result.event.subjects).toEqual(["github:acme/widgets", "github:acme"])
    expect(result.event.summary).toBe("Check suite failure for acme/widgets (main)")
    expect(result.event.data.head_branch).toBe("main")
    expect(result.event.data.number).toBeUndefined()
  })

  it("normalizes workflow_run.completed", () => {
    const result = normalizeGithubEvent({
      event: "workflow_run",
      deliveryId: "d7",
      payload: {
        action: "completed",
        workflow_run: { name: "CI", conclusion: "success", pull_requests: [{ number: 5 }] },
        repository: { full_name: "acme/widgets" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.type).toBe("github.workflow_run.completed")
    expect(result.event.subject).toBe("github:acme/widgets#5")
    expect(result.event.summary).toBe('Workflow run "CI" success for acme/widgets#5')
  })

  it("normalizes issue_comment.created on a PR-shaped issue", () => {
    const result = normalizeGithubEvent({
      event: "issue_comment",
      deliveryId: "d8",
      payload: {
        action: "created",
        issue: { number: 12, pull_request: { url: "https://api.github.com/…" } },
        comment: { user: { login: "dave" }, html_url: "https://github.com/acme/widgets/pull/12#comment" },
        repository: { full_name: "acme/widgets" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.type).toBe("github.issue_comment.created")
    expect(result.event.subject).toBe("github:acme/widgets#12")
    expect(result.event.summary).toBe("New comment on acme/widgets#12 by dave")
    expect(result.event.data.is_pull_request).toBe(true)
  })

  it("falls back to repository.owner.login / .name when full_name is absent", () => {
    const result = normalizeGithubEvent({
      event: "pull_request",
      deliveryId: "d9",
      payload: {
        action: "opened",
        pull_request: { number: 1 },
        repository: { owner: { login: "acme" }, name: "widgets" },
        sender: { login: "eve" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.subject).toBe("github:acme/widgets#1")
  })

  it("returns ok:false for an unrecognized event name", () => {
    const result = normalizeGithubEvent({ event: "push", deliveryId: "d10", payload: {} })
    expect(result).toEqual({ ok: false, reason: "unsupported_event:push" })
  })

  it("returns ok:false for a malformed payload rather than throwing", () => {
    expect(normalizeGithubEvent({ event: "pull_request", deliveryId: "d11", payload: null })).toEqual({
      ok: false,
      reason: "invalid_payload",
    })
    expect(
      normalizeGithubEvent({
        event: "pull_request",
        deliveryId: "d12",
        payload: { action: "opened", repository: { full_name: "acme/widgets" } },
      }),
    ).toEqual({ ok: false, reason: "missing_pull_request_number" })
    expect(
      normalizeGithubEvent({
        event: "pull_request",
        deliveryId: "d13",
        payload: { action: "opened", pull_request: { number: 1 } },
      }),
    ).toEqual({ ok: false, reason: "missing_repository" })
  })

  it("GITHUB_DEFAULT_PR_TYPES matches design §4's default PR type set (check_run excluded)", () => {
    expect(GITHUB_DEFAULT_PR_TYPES).toEqual([
      "github.check_suite.completed",
      "github.workflow_run.completed",
      "github.pull_request_review.submitted",
      "github.pull_request.closed",
      "github.issue_comment.created",
    ])
    expect(GITHUB_DEFAULT_PR_TYPES.some(t => t.startsWith("github.check_run"))).toBe(false)
  })
})
