import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  classifyDrift,
  collectPins,
  parseAdapterSource,
  parseRangeFloor,
  splitPackageSpec,
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

test("classifies drift as none, patch, minor or major", () => {
  assert.equal(classifyDrift("1.2.3", "1.2.3"), "none")
  assert.equal(classifyDrift("1.2.3", "1.2.4"), "patch")
  assert.equal(classifyDrift("1.2.3", "1.3.0"), "minor")
  assert.equal(classifyDrift("1.2.3", "2.0.0"), "major")
  assert.equal(classifyDrift("2.0.0", "1.9.9"), "none")
  assert.equal(classifyDrift("1.2.3-beta.1", "1.2.3"), "patch")
  assert.equal(classifyDrift("1.2.3", null), "unknown")
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

test("collects the fixture adapters and skips non-npm and local-only pins", () => {
  const { pins, skipped } = collectPins(FIXTURES)
  assert.deepEqual(pins, [
    { adapter: "exact", package: "@scope/wrapper", pinned: "1.2.3" },
    { adapter: "ranged", package: "ranged-cli", pinned: "1.4.0" },
    { adapter: "robust", package: "robust-cli", pinned: "2.3.4" },
  ])
  assert.deepEqual(skipped, ["local", "non-npm"])
})
