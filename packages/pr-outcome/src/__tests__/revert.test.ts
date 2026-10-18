import { test } from "vitest"
import assert from "node:assert/strict"
import { isRevertOf } from "../revert.js"
import type { GhPull } from "../types.js"

const base: GhPull = {
  number: 7,
  state: "closed",
  merged: true,
  mergedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  body: "body",
  title: "Fix foo bar",
  headRefName: "fix-foo",
  mergeCommitSha: "abcdef1234567890abcdef1234567890abcdef12",
}

test("exact Revert title, with or without a (#N) suffix", () => {
  assert.equal(isRevertOf(base, [{ title: 'Revert "Fix foo bar"' }]), true)
  assert.equal(isRevertOf(base, [{ title: 'Revert "Fix foo bar" (#12)' }]), true)
  assert.equal(isRevertOf(base, [{ title: 'Revert "Fix other thing"' }]), false)
  assert.equal(isRevertOf(base, [{ title: 'Revert "Fix foo bar baz"' }]), false)
})

test("body marker must carry this pull's merge commit sha", () => {
  assert.equal(isRevertOf(base, [{ body: "This reverts commit abcdef1234567890abcdef1234567890abcdef12." }]), true)
  assert.equal(isRevertOf(base, [{ body: "This reverts commit abcdef1." }]), true)
  assert.equal(isRevertOf(base, [{ body: "This reverts commit 0000000000." }]), false)
})

test("no merge sha means the body marker never matches", () => {
  assert.equal(isRevertOf({ ...base, mergeCommitSha: undefined }, [{ body: "This reverts commit abcdef1234." }]), false)
})

test("no candidates and unrelated candidates", () => {
  assert.equal(isRevertOf(base, []), false)
  assert.equal(isRevertOf(base, [{ title: "Fix foo bar again" }]), false)
})
