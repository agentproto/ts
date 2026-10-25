/**
 * Pure unit tests for the composable sentinel coalesce registry
 * (`sentinel-coalesce.ts`): type matching (exact + `*` prefix), the default
 * `github-ci` / `github-push` rules, the `sentinel:<ruleId>:<key>`
 * namespacing, and the register/unregister handle that makes a new event
 * family a one-object change.
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  coalesceKeyFor,
  listSentinelCoalesceRules,
  matchesType,
  registerSentinelCoalesceRule,
} from "../sentinel-coalesce.js"
import type { SentinelEvent } from "../sentinel-providers/types.js"

function makeEvent(over: Partial<SentinelEvent> & Pick<SentinelEvent, "type">): SentinelEvent {
  return {
    specversion: "1.0",
    id: "evt_1",
    source: "//agentproto.local/sentinel/local-gh",
    subject: "github:acme/widgets#42",
    time: "2026-10-01T00:00:00.000Z",
    datacontenttype: "application/json",
    data: {},
    summary: "x",
    subjects: ["github:acme/widgets#42", "github:acme/widgets", "github:acme"],
    terminal: false,
    ...over,
  }
}

const unregister: Array<() => void> = []
afterEach(() => {
  while (unregister.length > 0) unregister.pop()?.()
})

describe("matchesType", () => {
  it("matches an exact type", () => {
    expect(matchesType("github.check_suite.completed", "github.check_suite.completed")).toBe(true)
    expect(matchesType("github.check_suite.completed", "github.check_suite.requested")).toBe(false)
    expect(matchesType("github.pull_request.synchronize", "github.pull_request.closed")).toBe(false)
  })

  it("matches a `*`-suffixed prefix and nothing beyond it", () => {
    expect(matchesType("github.check_suite.*", "github.check_suite.completed")).toBe(true)
    expect(matchesType("github.check_suite.*", "github.check_suite.requested")).toBe(true)
    expect(matchesType("github.check_suite.*", "github.workflow_run.completed")).toBe(false)
    expect(matchesType("github.status*", "github.status.success")).toBe(true)
    expect(matchesType("github.status*", "github.check_run.completed")).toBe(false)
  })
})

describe("default rules", () => {
  it("CI events key on subject + headSha (camelCase)", () => {
    const key = coalesceKeyFor(
      makeEvent({ type: "github.check_suite.completed", data: { headSha: "abc123def" } }),
    )
    expect(key).toBe("sentinel:github-ci:ci:github:acme/widgets#42:abc123def")
  })

  it("CI events also read GitHub's own head_sha spelling", () => {
    const key = coalesceKeyFor(
      makeEvent({ type: "github.workflow_run.completed", data: { head_sha: "abc123def" } }),
    )
    expect(key).toBe("sentinel:github-ci:ci:github:acme/widgets#42:abc123def")
  })

  it("a CI event with no head sha still coalesces (empty sha segment)", () => {
    const key = coalesceKeyFor(makeEvent({ type: "github.check_run.completed", data: {} }))
    expect(key).toBe("sentinel:github-ci:ci:github:acme/widgets#42:")
  })

  it("CI events for the same subject+sha share a key, a new head does not", () => {
    const a = coalesceKeyFor(makeEvent({ type: "github.check_suite.completed", data: { headSha: "sha1" } }))
    const b = coalesceKeyFor(
      makeEvent({ id: "evt_2", type: "github.check_suite.completed", data: { headSha: "sha1" } }),
    )
    const c = coalesceKeyFor(
      makeEvent({ id: "evt_3", type: "github.check_suite.completed", data: { headSha: "sha2" } }),
    )
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it("a push keys on subject alone", () => {
    const key = coalesceKeyFor(makeEvent({ type: "github.pull_request.synchronize", data: { headSha: "sha1" } }))
    expect(key).toBe("sentinel:github-push:push:github:acme/widgets#42")
  })

  it("an uncovered type coalesces with nothing", () => {
    expect(coalesceKeyFor(makeEvent({ type: "github.pull_request.closed" }))).toBeUndefined()
    expect(coalesceKeyFor(makeEvent({ type: "linear.issue.updated" }))).toBeUndefined()
  })

  it("the defaults are registered first, in order", () => {
    expect(listSentinelCoalesceRules().slice(0, 2).map(r => r.id)).toEqual(["github-ci", "github-push"])
  })
})

describe("custom rules", () => {
  it("a registered rule covers a new family; unregistering removes it", () => {
    unregister.push(
      registerSentinelCoalesceRule({
        id: "test-family",
        types: ["test.thing.*"],
        key: event => `t:${event.subject}`,
      }),
    )
    const covered = makeEvent({ type: "test.thing.happened" })
    expect(coalesceKeyFor(covered)).toBe("sentinel:test-family:t:github:acme/widgets#42")
    expect(listSentinelCoalesceRules().some(r => r.id === "test-family")).toBe(true)

    unregister.pop()?.()
    expect(coalesceKeyFor(covered)).toBeUndefined()
    expect(listSentinelCoalesceRules().some(r => r.id === "test-family")).toBe(false)
  })

  it("the first matching rule wins, and a rule that declines (undefined key) is not a coalesce", () => {
    unregister.push(
      registerSentinelCoalesceRule({
        id: "declines-some",
        types: ["custom.ci.*"],
        key: event => (event.data.never === true ? undefined : "always"),
      }),
    )
    unregister.push(
      registerSentinelCoalesceRule({
        id: "never-reached",
        types: ["custom.ci.*"],
        key: () => "shadowed",
      }),
    )
    expect(coalesceKeyFor(makeEvent({ type: "custom.ci.done", data: {} }))).toBe("sentinel:declines-some:always")
    // The first matching rule declined — the second must NOT get a look-in.
    expect(coalesceKeyFor(makeEvent({ type: "custom.ci.done", data: { never: true } }))).toBeUndefined()
  })
})
