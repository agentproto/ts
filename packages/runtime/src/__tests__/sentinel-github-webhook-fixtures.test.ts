/**
 * Raw-webhook fixtures for the GitHub normalizer (AIP-60 §4, step 5): the
 * payloads here carry the extra fields a real delivery has (installation,
 * nested user objects, urls…) so the normalizer is exercised the way the
 * `webhook` provider feeds it, not just with the trimmed shapes in
 * `sentinel-github-normalize.test.ts`.
 */

import { describe, expect, it } from "vitest"
import { normalizeGithubEvent } from "../sentinel-github-normalize.js"

const TIME = "2026-09-28T09:15:00.000Z"
const SOURCE = "//agentproto.local/sentinel/webhook"

const repository = {
  id: 1,
  name: "ts",
  full_name: "agentproto/ts",
  private: false,
  owner: { login: "agentproto", type: "Organization" },
  html_url: "https://github.com/agentproto/ts",
}
const sender = { login: "jeremy", id: 9, type: "User" }
const installation = { id: 55 }

function run(event: string, deliveryId: string, payload: unknown) {
  const r = normalizeGithubEvent({ event, deliveryId, payload, time: TIME, source: SOURCE })
  if (!r.ok) throw new Error(`normalize failed: ${r.reason}`)
  return r.event
}

describe("normalizeGithubEvent — raw webhook payloads", () => {
  it("pull_request closed + merged: terminal, PR/repo/owner hierarchy, webhook source", () => {
    const event = run("pull_request", "9c1d-merged", {
      action: "closed",
      number: 1428,
      pull_request: {
        url: "https://api.github.com/repos/agentproto/ts/pulls/1428",
        id: 77,
        html_url: "https://github.com/agentproto/ts/pull/1428",
        number: 1428,
        state: "closed",
        title: "feat(runtime): webhook sentinel provider",
        user: { login: "jeremy" },
        merged: true,
        merged_at: "2026-09-28T09:14:58Z",
        merged_by: { login: "maintainer" },
        head: { ref: "wt/sentinel-webhook", sha: "abc123def456" },
        base: { ref: "main" },
      },
      repository,
      sender: { login: "maintainer" },
      installation,
    })
    expect(event).toEqual({
      specversion: "1.0",
      id: "evt_9c1d-merged",
      source: SOURCE,
      type: "github.pull_request.closed",
      subject: "github:agentproto/ts#1428",
      time: TIME,
      datacontenttype: "application/json",
      data: {
        action: "closed",
        merged: true,
        repo: "agentproto/ts",
        number: 1428,
        title: "feat(runtime): webhook sentinel provider",
        url: "https://github.com/agentproto/ts/pull/1428",
        actor: "jeremy",
        head_sha: "abc123def456",
      },
      summary: "PR agentproto/ts#1428 merged by jeremy",
      subjects: ["github:agentproto/ts#1428", "github:agentproto/ts", "github:agentproto"],
      terminal: true,
    })
  })

  it("pull_request closed WITHOUT merge: still terminal, reported as closed", () => {
    const event = run("pull_request", "9c1d-closed", {
      action: "closed",
      number: 7,
      pull_request: { number: 7, title: "wip", html_url: "https://github.com/agentproto/ts/pull/7", merged: false, user: { login: "bob" }, head: { sha: "f00" } },
      repository,
      sender,
    })
    expect(event.terminal).toBe(true)
    expect(event.data.merged).toBe(false)
    expect(event.summary).toBe("PR agentproto/ts#7 closed by bob")
  })

  it("pull_request synchronize: non-terminal, carries the new head sha", () => {
    const event = run("pull_request", "9c1d-sync", {
      action: "synchronize",
      number: 1428,
      before: "aaa111",
      after: "bbb222",
      pull_request: {
        html_url: "https://github.com/agentproto/ts/pull/1428",
        number: 1428,
        title: "feat",
        user: { login: "jeremy" },
        merged: false,
        head: { ref: "wt/x", sha: "bbb222" },
      },
      repository,
      sender,
    })
    expect(event.type).toBe("github.pull_request.synchronize")
    expect(event.terminal).toBe(false)
    expect(event.subject).toBe("github:agentproto/ts#1428")
    expect(event.data.head_sha).toBe("bbb222")
    expect(event.summary).toBe("PR agentproto/ts#1428 synchronize by jeremy")
  })

  it("pull_request_review submitted: reviewer + state from the review object", () => {
    const event = run("pull_request_review", "9c1d-review", {
      action: "submitted",
      review: {
        id: 5,
        state: "changes_requested",
        body: "please add tests",
        user: { login: "carol" },
        html_url: "https://github.com/agentproto/ts/pull/1428#pullrequestreview-5",
      },
      pull_request: { number: 1428, title: "feat", head: { sha: "bbb222" } },
      repository,
      sender: { login: "carol" },
    })
    expect(event).toMatchObject({
      id: "evt_9c1d-review",
      type: "github.pull_request_review.submitted",
      subject: "github:agentproto/ts#1428",
      terminal: false,
      data: { action: "submitted", state: "changes_requested", repo: "agentproto/ts", number: 1428, actor: "carol" },
      summary: "PR agentproto/ts#1428 review changes_requested by carol",
      subjects: ["github:agentproto/ts#1428", "github:agentproto/ts", "github:agentproto"],
    })
  })

  it("check_suite completed for a PR: subject is the PR, conclusion + branch carried", () => {
    const event = run("check_suite", "9c1d-suite", {
      action: "completed",
      check_suite: {
        id: 88,
        head_branch: "wt/sentinel-webhook",
        head_sha: "bbb222",
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 1428, url: "https://api.github.com/repos/agentproto/ts/pulls/1428" }],
      },
      repository,
      sender: { login: "github-actions[bot]" },
    })
    expect(event).toMatchObject({
      type: "github.check_suite.completed",
      subject: "github:agentproto/ts#1428",
      terminal: false,
      data: {
        action: "completed",
        conclusion: "success",
        repo: "agentproto/ts",
        number: 1428,
        head_branch: "wt/sentinel-webhook",
        head_sha: "bbb222",
      },
      summary: "Check suite success for agentproto/ts#1428 @ bbb222",
    })
  })

  it("check_suite completed with no PR (e.g. a push to main): repo-level subject, branch in summary", () => {
    const event = run("check_suite", "9c1d-suite-main", {
      action: "completed",
      check_suite: { head_branch: "main", conclusion: "failure", pull_requests: [] },
      repository,
      sender,
    })
    expect(event.subject).toBe("github:agentproto/ts")
    expect(event.subjects).toEqual(["github:agentproto/ts", "github:agentproto"])
    expect(event.summary).toBe("Check suite failure for agentproto/ts (main)")
    expect(event.data.number).toBeUndefined()
  })

  it("issue_comment created on a PR: PR subject, flagged as a pull-request comment", () => {
    const event = run("issue_comment", "9c1d-comment", {
      action: "created",
      issue: {
        number: 1428,
        title: "feat",
        pull_request: { url: "https://api.github.com/repos/agentproto/ts/pulls/1428" },
      },
      comment: {
        id: 3,
        body: "LGTM",
        user: { login: "dave" },
        html_url: "https://github.com/agentproto/ts/pull/1428#issuecomment-3",
      },
      repository,
      sender: { login: "dave" },
    })
    expect(event).toMatchObject({
      id: "evt_9c1d-comment",
      type: "github.issue_comment.created",
      subject: "github:agentproto/ts#1428",
      terminal: false,
      data: {
        action: "created",
        number: 1428,
        actor: "dave",
        url: "https://github.com/agentproto/ts/pull/1428#issuecomment-3",
        is_pull_request: true,
      },
      summary: "New comment on agentproto/ts#1428 by dave",
    })
  })

  it("issue_comment on a plain issue is flagged is_pull_request: false", () => {
    const event = run("issue_comment", "9c1d-issue", {
      action: "created",
      issue: { number: 3, title: "bug" },
      comment: { user: { login: "eve" }, html_url: "https://github.com/agentproto/ts/issues/3#issuecomment-1" },
      repository,
    })
    expect(event.data.is_pull_request).toBe(false)
  })

  it("an unsupported event (push) is reported as such, not thrown", () => {
    expect(normalizeGithubEvent({ event: "push", deliveryId: "d", payload: { ref: "refs/heads/main", repository }, time: TIME })).toEqual({
      ok: false,
      reason: "unsupported_event:push",
    })
  })

  it("the same delivery normalizes to the same id every time (redelivery-stable)", () => {
    const payload = { action: "closed", pull_request: { number: 1, merged: true }, repository, sender }
    expect(run("pull_request", "same", payload).id).toBe(run("pull_request", "same", payload).id)
  })
})
