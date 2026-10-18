import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_PACKAGES, DEFAULTS, checkSpecDrift } from "./check-spec-drift.mjs"

test("checkSpecDrift passes on the in-sync vendored JSON draft", async () => {
  const result = await checkSpecDrift()
  assert.equal(result.ok, true, result.message)
})

test("every no-arg-CLI-guarded package is in sync with its vendored draft", async () => {
  assert.deepEqual(
    DEFAULT_PACKAGES.map(p => p.slug),
    [DEFAULTS.slug, "work"],
  )
  for (const pkg of DEFAULT_PACKAGES) {
    const result = await checkSpecDrift(pkg)
    assert.equal(result.ok, true, `@agentproto/${pkg.slug}: ${result.message}`)
  }
})

test("checkSpecDrift fails for a doctype with no vendored draft", async () => {
  const result = await checkSpecDrift({
    slug: "does-not-exist",
    doctype: "DOES-NOT-EXIST",
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /not found/)
})