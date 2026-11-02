import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  buildRows,
  classifyDrift,
  collectPins,
  compareSemver,
  parseAdapterSource,
  parseRangeFloor,
  splitPackageSpec,
  summarizeRows,
} from "./check-adapter-pins.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, "__fixtures__", "adapter-pins", "adapters")

test("splits scoped and unscoped package specs", () => {
  assert.deepEqual(splitPackageSpec("@scope/name@1.2.3"), { name: "@scope/name", version: "1.2.3" })
  assert.deepEqual(splitPackageSpec("@scope/name"), { name: "@scope/name", version: null })
  assert.deepEqual(splitPackageSpec("name@1.2.3"), { name: "name", version: "1.2.3" })
  assert.deepEqual(splitPackageSpec("name"), { name: "name", version: null })
})

test("reads the lower bound from a version range", () => {
  assert.equal(parseRangeFloor(">=1.4.0 <2"), "1.4.0")
  assert.equal(parseRangeFloor("=1.2.3"), "1.2.3")
  assert.equal(parseRangeFloor("*"), null)
})

test("compares semver including prerelease ordering", () => {
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0)
  assert.equal(compareSemver("1.2.3", "1.2.4"), -1)
  assert.equal(compareSemver("2.0.0", "1.9.9"), 1)
  assert.equal(compareSemver("1.2.3-beta.1", "1.2.3"), -1)
  assert.equal(compareSemver("1.2.3-beta.2", "1.2.3-beta.1"), 1)
})

test("classifies drift as none, ahead, patch, minor or major", () => {
  assert.equal(classifyDrift("1.2.3", "1.2.3"), "none")
  assert.equal(classifyDrift("1.2.3", "1.2.4"), "patch")
  assert.equal(classifyDrift("1.2.3", "1.3.0"), "minor")
  assert.equal(classifyDrift("1.2.3", "2.0.0"), "major")
  assert.equal(classifyDrift("2.0.0", "1.9.9"), "ahead")
  assert.equal(classifyDrift("1.2.3-beta.1", "1.2.3"), "patch")
  assert.equal(classifyDrift("1.2.3", null), "unknown")
})

test("summarizes a registry failure as indeterminate rather than fresh", () => {
  const summary = summarizeRows([
    { drift: "none" },
    { drift: "unknown" },
    { drift: "patch" },
    { drift: "ahead" },
  ])
  assert.equal(summary.indeterminate, true)
  assert.equal(summary.fresh, false)
  assert.equal(summary.unknown.length, 1)
  assert.equal(summary.drifted.length, 2)
  assert.equal(summary.current.length, 1)

  const clean = summarizeRows([{ drift: "none" }])
  assert.equal(clean.indeterminate, false)
  assert.equal(clean.fresh, true)
})

test("extracts an exact install/bin_args pin", () => {
  assert.deepEqual(parseAdapterSource(`
    export const exact = defineHarness({
      bin: "npx",
      bin_args: ["-y", "@scope/wrapper@1.2.3"],
      install: [{ method: "npm", package: "@scope/wrapper@1.2.3", global: true }],
      version_check: { cmd: "npm ls -g @scope/wrapper --depth=0", range: "=1.2.3" },
    })
  `), [{ package: "@scope/wrapper", pinned: "1.2.3" }])
})

test("falls back to a version_check range floor when no exact pin exists", () => {
  assert.deepEqual(parseAdapterSource(`
    export const ranged = defineHarness({
      install: [{ method: "npm", package: "ranged-cli", global: true }],
      version_check: { cmd: "npm view ranged-cli version", range: ">=1.4.0 <2" },
    })
  `), [{ package: "ranged-cli", pinned: "1.4.0" }])
})

test("collects fixture adapters and skips non-npm and local-only pins", () => {
  const { pins, skipped } = collectPins(FIXTURES)
  assert.deepEqual(pins, [
    { adapter: "ahead", package: "ahead-cli", pinned: "9.9.9" },
    { adapter: "exact", package: "@scope/wrapper", pinned: "1.2.3" },
    { adapter: "final", package: "final-cli", pinned: "5.6.7" },
    { adapter: "ranged", package: "ranged-cli", pinned: "1.4.0" },
    { adapter: "reordered", package: "reordered-cli", pinned: "3.4.5" },
    { adapter: "robust", package: "robust-cli", pinned: "2.3.4" },
  ])
  assert.deepEqual(skipped, ["local", "non-npm"])
})

test("buildRows reports ahead and none from injected registry results", async () => {
  const { pins } = collectPins(FIXTURES)
  const latest = {
    "ahead-cli": "1.0.0",
    "@scope/wrapper": "1.2.3",
    "final-cli": "5.6.7",
    "ranged-cli": "1.4.0",
    "reordered-cli": "3.4.5",
    "robust-cli": "2.3.4",
  }
  const rows = await buildRows(pins, async (pkg) => latest[pkg] ?? null)
  assert.equal(rows.find((row) => row.package === "ahead-cli").drift, "ahead")
  assert.ok(rows.filter((row) => row.package !== "ahead-cli").every((row) => row.drift === "none"))
})
