import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_ALLOWLIST, findPushSites, findViolations, runBlocks } from "./check-bot-push.mjs"

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "check-bot-push-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true })
  return root
}

test("finds a push inside a block run", () => {
  const text = ["jobs:", "  a:", "    steps:", "      - run: |", "          git fetch", "          git push"].join("\n")
  assert.deepEqual(findPushSites(text), [{ line: 6, command: "git push" }])
})

test("finds a push inside an inline run", () => {
  const text = "      - run: git push origin HEAD\n"
  assert.deepEqual(findPushSites(text), [{ line: 1, command: "git push origin HEAD" }])
})

test("ignores comments and non-run prose", () => {
  const text = ["# git push is banned here", "      - run: |", "          echo hello", "          # git push"].join("\n")
  assert.deepEqual(findPushSites(text), [])
})

test("runBlocks returns each run block", () => {
  const text = ["run: |", "  one", "run: two"].join("\n")
  assert.deepEqual(runBlocks(text), [
    { line: 1, body: "  one", startsAt: 2 },
    { line: 3, body: "two", inline: true },
  ])
})

test("violations skip the allowlist", (t) => {
  const root = fixture(t)
  writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "run: |\n  git push\n")
  writeFileSync(path.join(root, ".github", "workflows", "release.yml"), "run: |\n  git push\n")
  const violations = findViolations({ root })
  assert.deepEqual(
    violations.map((entry) => entry.file),
    ["ci.yml"],
  )
  assert.deepEqual(DEFAULT_ALLOWLIST, ["release.yml", "update-deps.yml"])
})
