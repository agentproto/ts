import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_PACKAGES, DEFAULTS, checkSpecDrift, cliTargets, schemaCode } from "./check-spec-drift.mjs"

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

test("a manual --aip run passes the same flags as the scripted run for a guarded package", () => {
  // AIP-72 is generated with --inline-refs; a manual check of it must regen
  // the same way, or it reports the $refs as drift.
  assert.deepEqual(cliTargets(["--aip", "72", "--slug", "memory", "--doctype", "memory"]), [
    { aip: 72, slug: "memory", doctype: "MEMORY", inlineRefs: true },
  ])
  assert.deepEqual(cliTargets(["--aip", "72", "--slug", "memory", "--doctype", "MEMORY"]), [
    DEFAULT_PACKAGES.find(p => p.slug === "memory"),
  ])
})

test("a manual run of an unguarded package takes --inline-refs as a flag", () => {
  assert.deepEqual(cliTargets(["--aip", "99", "--slug", "x", "--doctype", "X"]), [
    { aip: 99, slug: "x", doctype: "X" },
  ])
  assert.deepEqual(cliTargets(["--aip", "99", "--inline-refs", "--slug", "x", "--doctype", "X"]), [
    { aip: 99, slug: "x", doctype: "X", inlineRefs: true },
  ])
})

test("the no-arg run checks every guarded package", () => {
  assert.deepEqual(cliTargets([]), DEFAULT_PACKAGES)
})

test("a manual check of AIP-72 is in sync", async () => {
  for (const t of cliTargets(["--aip", "72", "--slug", "memory", "--doctype", "MEMORY"])) {
    const result = await checkSpecDrift(t)
    assert.equal(result.ok, true, result.message)
  }
})
