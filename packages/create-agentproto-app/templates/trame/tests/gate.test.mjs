/**
 * tests/gate.test.mjs — node:test runner for the scaffold's example gate.
 * `node --test tests/` must stay green: it is the cheapest drift alarm on
 * the app's deterministic surface.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

test("example gate passes and prints a JSON report", () => {
  const res = spawnSync("node", ["gates/example.mjs"], {
    cwd: appRoot,
    encoding: "utf8",
  })
  assert.equal(res.status, 0, `gate exited ${res.status}: ${res.stderr}`)
  const report = JSON.parse(String(res.stdout).trim())
  assert.equal(report.ok, true)
  assert.deepEqual(report.findings, [])
})
