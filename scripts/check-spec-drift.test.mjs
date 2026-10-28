import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_PACKAGES, DEFAULTS, checkSpecDrift, schemaCode } from "./check-spec-drift.mjs"

test("checkSpecDrift passes on the in-sync vendored JSON draft", async () => {
  const result = await checkSpecDrift()
  assert.equal(result.ok, true, result.message)
})

test("every no-arg-CLI-guarded package is in sync with its vendored draft", async () => {
  assert.deepEqual(
    DEFAULT_PACKAGES.map(p => p.slug),
    [DEFAULTS.slug, "work", "memory"],
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
test("schemaCode ignores the leading doc comment, so a package can keep its own header", () => {
  const regen = '/**\n * Template header.\n */\n\nimport { z } from "zod"\nexport const s = z.string()\n'
  const checkedIn = '/**\n * Package-specific header,\n * longer than the template.\n */\n\nimport { z } from "zod"\nexport const s = z.string()\n'
  assert.equal(schemaCode(checkedIn), schemaCode(regen))
})

test("schemaCode still exposes a drift in the code below the header", () => {
  const regen = '/** h */\nimport { z } from "zod"\nexport const s = z.string().min(1)\n'
  const checkedIn = '/** h */\nimport { z } from "zod"\nexport const s = z.string()\n'
  assert.notEqual(schemaCode(checkedIn), schemaCode(regen))
})

test("schemaCode compares a file with no header as-is", () => {
  const src = 'import { z } from "zod"\n'
  assert.equal(schemaCode(src), src)
})
