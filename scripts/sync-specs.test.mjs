import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

const ROOT = resolve(import.meta.dirname, "..")
const SCRIPT = resolve(ROOT, "scripts/sync-specs.mjs")

/** Build an isolated { source, target, allowlist } fixture triple under a
 *  fresh tmp dir, so these tests never touch this repo's real
 *  specs/resources or specs/spec-drift-allowlist.json. */
function makeFixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), "sync-specs-test-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const source = join(tmp, "source")
  const target = join(tmp, "target", "resources")
  const allowlist = join(tmp, "allowlist.json")
  mkdirSync(join(source, "aip-1", "draft"), { recursive: true })
  mkdirSync(join(target, "aip-1", "draft"), { recursive: true })
  return { tmp, source, target, allowlist }
}

function writeSchema(dir, obj) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "FOO.schema.json"), `${JSON.stringify(obj, null, 2)}\n`)
}

function writeAllowlist(path, entries) {
  writeFileSync(path, JSON.stringify({ description: "test fixture", entries }, null, 2))
}

function run(fixtureArgs) {
  const res = spawnSync(process.execPath, [SCRIPT, ...fixtureArgs], { encoding: "utf8" })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

test("--check passes when target has only allowlisted drift", (t) => {
  const { source, target, allowlist } = makeFixture(t)
  writeSchema(join(source, "aip-1", "draft"), { type: "object", properties: { name: { type: "string" } } })
  writeSchema(join(target, "aip-1", "draft"), {
    type: "object",
    properties: { name: { type: "string" }, extra: { type: "boolean" } },
  })
  writeAllowlist(allowlist, [
    { file: "aip-1/draft/FOO.schema.json", field: "properties.extra", reason: "test-only ts-ahead field" },
  ])
  const res = run(["--source", source, "--target", target, "--allowlist", allowlist, "--check"])
  assert.equal(res.status, 0, res.stdout + res.stderr)
})

test("--check fails on drift the allowlist doesn't cover", (t) => {
  const { source, target, allowlist } = makeFixture(t)
  writeSchema(join(source, "aip-1", "draft"), { type: "object", properties: { name: { type: "string" } } })
  writeSchema(join(target, "aip-1", "draft"), {
    type: "object",
    properties: { name: { type: "string" }, unaccounted: { type: "boolean" } },
  })
  writeAllowlist(allowlist, [])
  const res = run(["--source", source, "--target", target, "--allowlist", allowlist, "--check"])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /drift/)
})

test("--check fails when an allowlisted field was silently dropped", (t) => {
  const { source, target, allowlist } = makeFixture(t)
  writeSchema(join(source, "aip-1", "draft"), { type: "object", properties: { name: { type: "string" } } })
  // target now matches source exactly — the allowlisted field is gone.
  writeSchema(join(target, "aip-1", "draft"), { type: "object", properties: { name: { type: "string" } } })
  writeAllowlist(allowlist, [
    { file: "aip-1/draft/FOO.schema.json", field: "properties.extra", reason: "test-only ts-ahead field" },
  ])
  const res = run(["--source", source, "--target", target, "--allowlist", allowlist, "--check"])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /allowlist integrity failed/)
  assert.match(res.stderr, /missing from the vendored copy/)
})

test("--check without --source degrades to the network-free allowlist-presence check", (t) => {
  const { target, allowlist } = makeFixture(t)
  writeSchema(join(target, "aip-1", "draft"), {
    type: "object",
    properties: { name: { type: "string" }, extra: { type: "boolean" } },
  })
  writeAllowlist(allowlist, [
    { file: "aip-1/draft/FOO.schema.json", field: "properties.extra", reason: "test-only ts-ahead field" },
  ])
  // No --source: this is the shape the CI step runs in (no network, no
  // sibling agentproto/agentproto checkout).
  const res = run(["--target", target, "--allowlist", allowlist, "--check"])
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.match(res.stdout, /network-free/)
})

test("a plain sync grafts allowlisted fields onto real upstream changes instead of reverting them", (t) => {
  const { source, target, allowlist } = makeFixture(t)
  writeSchema(join(source, "aip-1", "draft"), {
    type: "object",
    properties: { name: { type: "string" }, newUpstreamField: { type: "string" } },
  })
  writeSchema(join(target, "aip-1", "draft"), {
    type: "object",
    properties: { name: { type: "string" }, extra: { type: "boolean" } },
  })
  writeAllowlist(allowlist, [
    { file: "aip-1/draft/FOO.schema.json", field: "properties.extra", reason: "test-only ts-ahead field" },
  ])
  const res = run(["--source", source, "--target", target, "--allowlist", allowlist])
  assert.equal(res.status, 0, res.stdout + res.stderr)

  const written = JSON.parse(readFileSync(join(target, "aip-1", "draft", "FOO.schema.json"), "utf8"))
  assert.equal(written.properties.extra.type, "boolean", "allowlisted field preserved")
  assert.equal(written.properties.newUpstreamField.type, "string", "real upstream change picked up")

  // And --check is now green against the same source/allowlist.
  const check = run(["--source", source, "--target", target, "--allowlist", allowlist, "--check"])
  assert.equal(check.status, 0, check.stdout + check.stderr)
})

test("--check passes on this repo's real vendored tree and allowlist", () => {
  // Integration check mirroring what CI actually runs (no --source: no
  // network, no sibling agentproto/agentproto checkout in CI).
  const res = run(["--check"])
  assert.equal(res.status, 0, res.stdout + res.stderr)
})
