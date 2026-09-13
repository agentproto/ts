import { test } from "node:test"
import assert from "node:assert/strict"
import { parseArgs } from "./deliver-artifact.mjs"

test("parseArgs reads the flags the delivery recipes pass", () => {
  const opts = parseArgs([
    "--kind",
    "pr",
    "--url",
    "https://api.github.com/repos/o/r/pulls",
    "--body-file",
    "pr.json",
  ])
  assert.equal(opts.kind, "pr")
  assert.equal(opts.url, "https://api.github.com/repos/o/r/pulls")
  assert.equal(opts.bodyFile, "pr.json")
  assert.equal(opts.method, "POST") // default
})

test("parseArgs uppercases --method and reads --sha/--ledger", () => {
  const opts = parseArgs([
    "--kind",
    "review",
    "--method",
    "put",
    "--sha",
    "abc123",
    "--ledger",
    "/tmp/led.ndjson",
  ])
  assert.equal(opts.method, "PUT")
  assert.equal(opts.sha, "abc123")
  assert.equal(opts.ledger, "/tmp/led.ndjson")
})

test("parseArgs ignores unknown flags rather than aborting", () => {
  const opts = parseArgs(["--kind", "comment", "--surprise", "x", "--url", "u", "--body-file", "b"])
  assert.equal(opts.kind, "comment")
  assert.equal(opts.url, "u")
  assert.equal(opts.bodyFile, "b")
})
