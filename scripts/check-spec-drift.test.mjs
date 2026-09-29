import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS, checkSpecDrift } from "./check-spec-drift.mjs"

test("checkSpecDrift passes on the in-sync vendored JSON draft", async () => {
  const result = await checkSpecDrift()
  assert.equal(result.ok, true, result.message)
})

test("checkSpecDrift fails for a doctype with no vendored draft", async () => {
  const result = await checkSpecDrift({
    slug: "does-not-exist",
    doctype: "DOES-NOT-EXIST",
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /not found/)
})