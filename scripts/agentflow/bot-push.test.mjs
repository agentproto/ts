import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { casPush } from "../../packages/git-cas/dist/index.mjs"
import { checkHead, renderParkComment, writeParkArtifacts } from "./bot-push.mjs"

function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function initRepo(dir, name) {
  execFileSync("git", ["init", "-q", dir])
  sh(dir, "config", "user.name", name)
  sh(dir, "config", "user.email", `${name}@example.test`)
}

function commit(dir, file, text, message) {
  writeFileSync(path.join(dir, file), text)
  sh(dir, "add", file)
  sh(dir, "commit", "-q", "-m", message)
  return sh(dir, "rev-parse", "HEAD")
}

function clone(bare, dir) {
  execFileSync("git", ["clone", "-q", bare, dir])
  sh(dir, "config", "user.name", "Fixer")
  sh(dir, "config", "user.email", "fixer@example.test")
  sh(dir, "checkout", "-B", "feature", "origin/feature")
}

function scratch(t) {
  const root = mkdtempSync(path.join(tmpdir(), "bot-push-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bare = path.join(root, "remote.git")
  execFileSync("git", ["init", "-q", "--bare", bare])
  const seed = path.join(root, "seed")
  initRepo(seed, "Seed")
  const a = commit(seed, "a.txt", "a\n", "A")
  sh(seed, "branch", "-M", "feature")
  sh(seed, "remote", "add", "origin", bare)
  sh(seed, "push", "-q", "-u", "origin", "feature")
  return { root, bare, seed, a }
}

test("pr-fix scenario: a human push between review and fix yields head_moved", async (t) => {
  const { root, bare, a } = scratch(t)
  const review = path.join(root, "review")
  clone(bare, review)
  const reviewed = commit(review, "changeset.txt", "c\n", "review changeset")
  const pushed = await casPush({ cwd: review, branch: "feature", expected: { sha: a } })
  assert.equal(pushed.outcome, "pushed")
  assert.equal(pushed.to, reviewed)

  const human = path.join(root, "human")
  clone(bare, human)
  const b = commit(human, "human.txt", "b\n", "human push")
  sh(human, "push", "-q", "origin", "feature")

  commit(review, "fix.txt", "f\n", "auto-fix from review (iter 1)")
  const precheck = await checkHead({ cwd: review, branch: "feature", expected: reviewed })
  assert.equal(precheck.moved, true)
  assert.equal(precheck.actual, b)

  const fix = await casPush({ cwd: review, branch: "feature", expected: { sha: reviewed } })
  assert.equal(fix.outcome, "head_moved")
  assert.equal(fix.expected, reviewed)
  assert.equal(fix.actual, b)
  assert.equal(sh(bare, "rev-parse", "feature"), b)

  const park = await writeParkArtifacts({
    cwd: review,
    expected: reviewed,
    actual: b,
    branch: "feature",
    pr: "42",
    step: "the fix",
    repo: "",
  })
  assert.ok(existsSync(path.join(review, park.patchPath)))
  const patch = readFileSync(path.join(review, park.patchPath), "utf8")
  assert.match(patch, /auto-fix from review \(iter 1\)/)
  const meta = JSON.parse(readFileSync(path.join(review, park.metaPath), "utf8"))
  assert.equal(meta.expected, reviewed)
  assert.equal(meta.actual, b)
  assert.equal(meta.artifactName, `parked-fix-42-${reviewed.slice(0, 7)}`)
})

test("pr-fix no-regression: with no human push the fix lands on the reviewed changeset", async (t) => {
  const { root, bare, a } = scratch(t)
  const review = path.join(root, "review")
  clone(bare, review)
  const reviewed = commit(review, "changeset.txt", "c\n", "review changeset")
  const pushed = await casPush({ cwd: review, branch: "feature", expected: { sha: a } })
  assert.equal(pushed.outcome, "pushed")

  const precheck = await checkHead({ cwd: review, branch: "feature", expected: reviewed })
  assert.equal(precheck.moved, false)

  const fix = commit(review, "fix.txt", "f\n", "auto-fix from review (iter 1)")
  const landed = await casPush({ cwd: review, branch: "feature", expected: { sha: reviewed } })
  assert.equal(landed.outcome, "pushed")
  assert.equal(landed.to, fix)
  assert.equal(sh(bare, "rev-parse", "feature"), fix)
})

test("old plain-push body lands the fix on the unreviewed head", async (t) => {
  const { root, bare, a } = scratch(t)
  const review = path.join(root, "review")
  clone(bare, review)
  commit(review, "changeset.txt", "c\n", "review changeset")
  await casPush({ cwd: review, branch: "feature", expected: { sha: a } })

  const human = path.join(root, "human")
  clone(bare, human)
  commit(human, "human.txt", "b\n", "human push")
  sh(human, "push", "-q", "origin", "feature")

  commit(human, "fix.txt", "f\n", "auto-fix from review (iter 1)")
  sh(human, "push", "-q", "origin", "feature")
  assert.notEqual(sh(bare, "rev-parse", "feature"), sh(review, "rev-parse", "HEAD"))
})

test("renderParkComment respects the command trigger constraint", () => {
  const body = renderParkComment({
    expected: "a".repeat(40),
    actual: "b".repeat(40),
    actualAuthor: "@agentproto-bot",
    step: "the fix",
    artifactName: "parked-fix-42-aaaaaaa",
    artifactUrl: "https://example.test/artifact",
    skipCi: false,
  })
  assert.equal(body.startsWith("/"), false)
  assert.equal(body.includes("@agentproto-bot"), false)
  assert.ok(body.startsWith("<!-- agentic-parked:"))
  assert.match(body, /pushed by `agentproto-bot`/)
})

test("renderParkComment refuses a violating body", () => {
  assert.throws(
    () =>
      renderParkComment({
        expected: "a".repeat(40),
        actual: "b".repeat(40),
        artifactName: "seen @agentproto-bot here",
        artifactUrl: "",
      }),
    /trigger constraint/,
  )
})
