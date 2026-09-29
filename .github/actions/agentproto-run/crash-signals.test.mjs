import { test } from "node:test"
import assert from "node:assert/strict"
import { detectAdapterCrash } from "./crash-signals.mjs"

test("flags the OOM-kill tail seen live on #1597", () => {
  const tail = [
    "[tool] bash {\"cwd\":\"/home/user\"}",
    "[error] ACP connection closed",
    "  Killed",
    "  npm notice",
  ].join("\n")
  const hits = detectAdapterCrash(tail)
  assert.ok(hits.includes("ACP connection closed"))
  assert.ok(hits.some((h) => h.startsWith("process Killed")))
})

test("flags a session that ended with status 'error'", () => {
  assert.deepEqual(detectAdapterCrash("session sess_ab12cd34 ended with status 'error'"), [
    "session ended with status 'error'",
  ])
})

test("ignores ordinary output, including the word Killed inside a sentence", () => {
  assert.deepEqual(detectAdapterCrash("Review posted.\nKilled the flaky test by fixing the mock."), [])
  assert.deepEqual(detectAdapterCrash(""), [])
  assert.deepEqual(detectAdapterCrash(undefined), [])
})
