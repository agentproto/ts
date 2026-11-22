import { test } from "node:test"
import assert from "node:assert/strict"
import { findViolations } from "./check-private-names.mjs"

const names = ["acmecorp", "secret[ -]?repo"]
const run = (files, exceptions = []) =>
  findViolations({ files: Object.keys(files), readText: f => files[f], names, exceptions })

test("a clean tree has no violations", () => {
  assert.deepEqual(run({ "a.ts": "export const x = 1\n" }), [])
})

test("matches content case-insensitively with file and line", () => {
  const v = run({ "a.ts": "ok\n// from AcmeCorp prod\n" })
  assert.equal(v.length, 1)
  assert.equal(v[0].file, "a.ts")
  assert.equal(v[0].line, 2)
})

test("matches file paths", () => {
  const v = run({ "docs/acmecorp.md": "clean" })
  assert.equal(v.length, 1)
  assert.equal(v[0].line, 0)
})

test("matches a name written with a separator", () => {
  assert.equal(run({ "a.md": "see Secret Repo" }).length, 1)
})

test("an exception path is skipped, others are not", () => {
  const files = { "a.md": "acmecorp", "b.md": "acmecorp" }
  assert.deepEqual(run(files, ["a.md"]).map(v => v.file), ["b.md"])
})

test("the shipped config has an empty exceptions list", async () => {
  const { readFileSync } = await import("node:fs")
  const cfg = JSON.parse(readFileSync(new URL("./private-names.json", import.meta.url), "utf8"))
  assert.deepEqual(cfg.exceptions, [])
  assert.ok(cfg.names.length > 0)
})
