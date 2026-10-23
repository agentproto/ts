import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { checkNames } from "./check-names.mjs"

const SCRIPT = resolve(fileURLToPath(new URL(".", import.meta.url)), "check-names.mjs")

/** Isolated root with `specs/names.json`, `packages/<dir>/package.json` +
 *  `src/index.ts`, and optionally `scripts/names-pending.json`. Nothing here
 *  touches the real repo. */
function makeFixture(t, { aips = [], packages = {}, pending, pendingRaw }) {
  const root = mkdtempSync(join(tmpdir(), "check-names-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const namesPath = join(root, "specs", "names.json")
  mkdirSync(dirname(namesPath), { recursive: true })
  writeFileSync(namesPath, JSON.stringify({ version: 1, layers: [], aips }))

  for (const [dir, { name, source = "" }] of Object.entries(packages)) {
    const pkgDir = join(root, "packages", dir)
    mkdirSync(join(pkgDir, "src"), { recursive: true })
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name }))
    writeFileSync(join(pkgDir, "src", "index.ts"), source)
  }

  if (pending !== undefined || pendingRaw !== undefined) {
    mkdirSync(join(root, "scripts"), { recursive: true })
    writeFileSync(
      join(root, "scripts", "names-pending.json"),
      pendingRaw ?? JSON.stringify({ pending }),
    )
  }

  return { root, namesPath }
}

const POLICY_ENTRY = {
  aip: 38,
  name: "POLICY",
  specId: "policy/v1",
  package: "@agentproto/policy",
  define: "definePolicy",
  layer: "primitives",
}

const CONFORMANT_SOURCE = 'export const SPEC_NAME = "policy/v1"\nexport function definePolicy() {}\n'

test("a conformant package passes", (t) => {
  const { root, namesPath } = makeFixture(t, {
    aips: [POLICY_ENTRY],
    packages: { policy: { name: "@agentproto/policy", source: CONFORMANT_SOURCE } },
  })
  const result = checkNames({ root, namesPath })
  assert.equal(result.skipped, false)
  assert.equal(result.deviations.size, 0)
  assert.deepEqual(result.fresh, [])
  assert.deepEqual(result.fixed, [])
})

test("a missing package fails with ts:aip-<n>:package", (t) => {
  const { root, namesPath } = makeFixture(t, { aips: [POLICY_ENTRY] })
  const result = checkNames({ root, namesPath })
  assert.deepEqual(result.fresh, ["ts:aip-38:package"])
  assert.match(result.deviations.get("ts:aip-38:package").message, /@agentproto\/policy/)
})

test("a wrong SPEC_NAME fails with ts:aip-<n>:spec-name and a file:line", (t) => {
  const { root, namesPath } = makeFixture(t, {
    aips: [{ ...POLICY_ENTRY, define: undefined }],
    packages: { policy: { name: "@agentproto/policy", source: 'export const SPEC_NAME = "agentpolicy/v1"\n' } },
  })
  const result = checkNames({ root, namesPath })
  assert.deepEqual(result.fresh, ["ts:aip-38:spec-name"])
  assert.match(result.deviations.get("ts:aip-38:spec-name").where, /packages\/policy\/src\/index\.ts:1$/)
})

test("a missing define export fails with ts:aip-<n>:define", (t) => {
  const { root, namesPath } = makeFixture(t, {
    aips: [POLICY_ENTRY],
    packages: { policy: { name: "@agentproto/policy", source: 'export const SPEC_NAME = "policy/v1"\n' } },
  })
  const result = checkNames({ root, namesPath })
  assert.deepEqual(result.fresh, ["ts:aip-38:define"])
})

test("a package claiming a spec name that no entry names fails as unregistered", (t) => {
  const { root, namesPath } = makeFixture(t, {
    aips: [],
    packages: { thing: { name: "@agentproto/thing", source: 'export const SPEC_NAME = "agentthing/v1"\n' } },
  })
  const result = checkNames({ root, namesPath })
  assert.deepEqual(result.fresh, ["ts:package:@agentproto/thing:unregistered"])
  assert.match(result.deviations.get("ts:package:@agentproto/thing:unregistered").where, /packages\/thing\/src\/index\.ts:1$/)
})

test("a superseded entry is exempt", (t) => {
  const { root, namesPath } = makeFixture(t, {
    aips: [{ aip: 8, name: "AGENCY", specId: "agency/v1", package: "@agentproto/agency-old", supersededBy: 21 }],
  })
  const result = checkNames({ root, namesPath })
  assert.deepEqual(result.fresh, [])
})

test("a pending deviation passes", (t) => {
  const { root, namesPath } = makeFixture(t, {
    aips: [{ ...POLICY_ENTRY, define: undefined }],
    packages: { policy: { name: "@agentproto/policy", source: 'export const SPEC_NAME = "agentpolicy/v1"\n' } },
    pending: ["ts:aip-38:spec-name"],
  })
  const result = checkNames({ root, namesPath })
  assert.deepEqual(result.fresh, [])
  assert.deepEqual(result.fixed, [])
})

test("a pending id that no longer deviates fails", (t) => {
  const { root, namesPath } = makeFixture(t, {
    aips: [POLICY_ENTRY],
    packages: { policy: { name: "@agentproto/policy", source: CONFORMANT_SOURCE } },
    pending: ["ts:aip-38:spec-name"],
  })
  const result = checkNames({ root, namesPath })
  assert.deepEqual(result.fixed, ["ts:aip-38:spec-name"])
})

test("a missing names.json skips with exit 0", (t) => {
  const root = mkdtempSync(join(tmpdir(), "check-names-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const result = checkNames({ root, namesPath: join(root, "nowhere", "names.json") })
  assert.equal(result.skipped, true)
  assert.equal(result.deviations.size, 0)

  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--names", join(root, "nowhere", "names.json")], {
    encoding: "utf8",
  })
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.match(res.stdout, /skipped.*does not exist/)
})

test("the CLI exits 1 and prints the failing deviation with file:line", (t) => {
  const { root, namesPath } = makeFixture(t, {
    aips: [{ ...POLICY_ENTRY, define: undefined }],
    packages: { policy: { name: "@agentproto/policy", source: 'export const SPEC_NAME = "agentpolicy/v1"\n' } },
  })
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--names", namesPath], { encoding: "utf8" })
  assert.equal(res.status, 1, res.stdout + res.stderr)
  assert.match(res.stderr, /packages\/policy\/src\/index\.ts:1.*\[ts:aip-38:spec-name\] \(new deviation\)/)
  assert.match(res.stdout, /1 package\(s\): 1 deviations \(0 pending, 1 new, 0 fixed\)/)
})

test("--write-pending bootstraps the ratchet and a second run passes", (t) => {
  const { root, namesPath } = makeFixture(t, {
    aips: [{ ...POLICY_ENTRY, define: undefined }],
    packages: { policy: { name: "@agentproto/policy", source: 'export const SPEC_NAME = "agentpolicy/v1"\n' } },
  })
  const first = spawnSync(process.execPath, [SCRIPT, "--root", root, "--names", namesPath, "--write-pending"], {
    encoding: "utf8",
  })
  assert.equal(first.status, 0, first.stdout + first.stderr)

  const second = checkNames({ root, namesPath })
  assert.deepEqual(second.fresh, [])
  assert.deepEqual(second.fixed, [])
  assert.deepEqual(second.pending, ["ts:aip-38:spec-name"])
})
