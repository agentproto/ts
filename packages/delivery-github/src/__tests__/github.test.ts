import { createClassifierRegistry, type ClassifyContext, type Envelope } from "@agentproto/delivery"
import { describe, expect, it } from "vitest"

import {
  FAILURE_VERDICTS,
  GITHUB_CLASSIFIERS,
  GITHUB_COALESCE_RULES,
  GITHUB_TRIAGE_RULE_TABLE,
  githubCoalesceKeyFor,
  githubRepeatKeyFor,
  verdictOf,
} from "../github.js"

const ctx: ClassifyContext = { targetId: "sess_1" }

function env(type: string, over: Partial<Envelope> = {}): Envelope {
  return {
    specversion: "1.0",
    id: "evt_1",
    source: "agentproto:sentinel/sen_1",
    type,
    subject: "github:acme/widgets#42",
    subjects: ["github:acme/widgets#42", "github:acme/widgets", "github:acme"],
    time: "2026-11-01T00:00:00.000Z",
    summary: "x",
    data: {},
    terminal: false,
    ...over,
  }
}

describe("GitHub verdicts", () => {
  it("reads conclusion or state, lowercased", () => {
    expect(verdictOf(env("x", { data: { conclusion: "FAILURE" } }))).toBe("failure")
    expect(verdictOf(env("x", { data: { state: "CHANGES_REQUESTED" } }))).toBe("changes_requested")
    expect(verdictOf(env("x"))).toBe("")
  })

  it("names the failure-class verdicts", () => {
    expect([...FAILURE_VERDICTS].sort()).toEqual([
      "action_required",
      "cancelled",
      "changes_requested",
      "error",
      "failure",
      "timed_out",
    ])
  })
})

describe("GitHub classification table", () => {
  it("keeps the explicit event-class rows from PR #2444", () => {
    expect(GITHUB_TRIAGE_RULE_TABLE.map(row => row.eventClass)).toContain("github.check_suite.completed")
    expect(GITHUB_TRIAGE_RULE_TABLE.find(row => row.id === "review-changes-requested")?.decision).toBe("wake")
    expect(GITHUB_TRIAGE_RULE_TABLE.find(row => row.id === "pull-request-synchronize")?.decision).toBe("fyi")
  })

  it("a failure wins, a green check is fyi, a non-bot comment wakes", () => {
    const reg = createClassifierRegistry(GITHUB_CLASSIFIERS)
    expect(
      reg.classify(env("github.check_suite.completed", { data: { conclusion: "failure" } }), ctx),
    ).toEqual({ level: 2, rule: "failure" })
    expect(
      reg.classify(env("github.check_suite.completed", { data: { conclusion: "success" } }), ctx),
    ).toEqual({ level: 1, rule: "github-triage-table:check-suite-success" })
    expect(
      reg.classify(env("github.issue_comment.created", { data: { actor: "octocat" } }), ctx),
    ).toEqual({ level: 2, rule: "github-triage-table:issue-comment-human" })
    expect(
      reg.classify(env("github.issue_comment.created", { data: { actor: "dependabot[bot]" } }), ctx),
    ).toEqual({ level: 1, rule: "github-triage-table:issue-comment-bot" })
  })
})

describe("GitHub coalesce and repeat keys", () => {
  it("CI keys on subject + head sha and push keys on subject alone", () => {
    expect(
      githubCoalesceKeyFor(env("github.check_suite.completed", { data: { headSha: "abc" } })),
    ).toBe("sentinel:github-ci:ci:github:acme/widgets#42:abc")
    expect(githubCoalesceKeyFor(env("github.pull_request.synchronize"))).toBe(
      "sentinel:github-push:push:github:acme/widgets#42",
    )
    expect(GITHUB_COALESCE_RULES.map(rule => rule.id)).toEqual(["github-ci", "github-push"])
  })

  it("a non-failure gets a verdict-qualified repeat key", () => {
    expect(
      githubRepeatKeyFor(env("github.check_suite.completed", { data: { headSha: "abc", conclusion: "success" } })),
    ).toBe("sentinel:github-ci:ci:github:acme/widgets#42:abc|success")
  })

  it("a failure carries no repeat key", () => {
    expect(
      githubRepeatKeyFor(env("github.check_suite.completed", { data: { headSha: "abc", conclusion: "failure" } })),
    ).toBeUndefined()
    expect(
      githubRepeatKeyFor(
        env("github.pull_request_review.submitted", { data: { state: "CHANGES_REQUESTED" } }),
      ),
    ).toBeUndefined()
  })
})
