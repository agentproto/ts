import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import {
  ARCHIVED_OVERRIDES,
  CORE_FAMILY,
  SPEC_PATTERN,
  buildRows,
  classify,
  collectWorkspaceDirs,
  expandGlob,
  readWorkspaceGlobs,
  renderStatus,
  sanitizeReason,
} from "./gen-status.mjs"

const SCRIPT = resolve(fileURLToPath(new URL(".", import.meta.url)), "gen-status.mjs")
if (SCRIPT === undefined) throw new Error("unreachable — keeps import tree stable")

let tmp
let fixtureCounter = 0
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "gen-status-"))
})
after(() => rmSync(tmp, { recursive: true, force: true }))

function writePackageJson(root, dir, json) {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, dir, "package.json"), JSON.stringify(json, null, 2))
}

/** Fixture workspace mirroring the real globs: pkgs/* (packages/), adapters/*,
 *  plus a nested group (packages/driver/*). */
function makeFixture({ withDependents = false } = {}) {
  const root = join(tmp, `ws-${++counter}${withDependents ? "dep" : ""}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n  - "packages/driver/*"\n  - "adapters/*"\n  - "examples/*"\n',
  )
  writePackageJson(root, "packages/runtime", { name: "@w/runtime", version: "1.0.0", description: "the runtime" })
  writePackageJson(root, "packages/driver/core", {
    name: "@w/driver",
    version: "0.1.0",
    // Doctype-looking description that CORE_FAMILY must still pin to core.
    description: "AIP-30 DRIVER.md reference implementation",
  })
  writePackageJson(root, "packages/workflow", {
    name: "@w/workflow",
    version: "2.0.0",
    description: "AIP-15 WORKFLOW.md reference implementation",
  })
  writePackageJson(root, "packages/egress", { name: "@w/egress", version: "0.1.0", description: "dead prototype" })
  writePackageJson(root, "packages/identity", {
    name: "@w/identity",
    version: "0.2.0",
    description: "identity doctype prototype",
  })
  writePackageJson(root, "adapters/claude", {
    name: "@w/adapter-claude",
    version: "0.3.0",
    description: "AGENT-CLI adapter for Claude",
  })
  // Matched by the glob but not a workspace package: no package.json.
  mkdirSync(join(root, "examples/empty"), { recursive: true })
  if (withDependents) {
    // Someone still depends on @w/identity (archived override must NOT apply)
    // and someone depends on @w/egress too —相依 written below.
    writePackageJson(root, "packages/consumer", {
      name: "@w/consumer",
      version: "1.0.0",
      description: "depends on identity and egress",
      dependencies: { "@w/identity": "workspace:*", "@w/egress": "workspace:0.1.0" },
    })
  }
  return root
}

test("readWorkspaceGlobs parses the packages list", () => {
  assert.deepEqual(readWorkspaceGlobs(join(tmp, "ws-0")), ["packages/*", "packages/driver/*", "adapters/*", "examples/*"])
})

test("--count: expandGlob only counts child dirs with a package.json", () => {
  const root = makeFixture()
  assert.deepEqual(collectWorkspaceDirs(root), ["adapters/claude", "packages/driver/core", "packages/egress", "packages/identity", "packages/runtime", "packages/workflow"])
})

test("expandGlob ignores a star-glob dir without a package.json", () => {
  const root = makeFixture()
  assert.deepEqual(expandGlob(root, "examples/*"), [])
  assert.deepEqual(expandGlob(root, "packages"), [])
  assert.deepEqual(expandGlob(root, "packages/driver/*"), ["packages/driver/core"])
})

test("each package lands in exactly one tier; core family wins over spec keywords", () => {
  const root = makeFixture()
  const rows = buildRows(root)
  const dirs = rows.map((r) => r.path)
  assert.equal(new Set(dirs).size, dirs.length, "no duplicate paths")
  assert.equal(new Set(rows.map((r) => r.name)).size, dirs.length, "no duplicate names")
  const tiers = Object.fromEntries(rows.map((r) => [r.path, r.tier]))
  assert.equal(tiers["packages/runtime"], "core")
  assert.equal(tiers["packages/driver/core"], "core", "core family beats the spec heuristic")
  assert.equal(tiers["packages/workflow"], "spec-reference")
  assert.equal(tiers["adapters/claude"], "adapters")
  assert.equal(tiers["packages/egress"], "archived")
  assert.equal(tiers["packages/identity"], "archived")
})

test("archived override is skipped (natural tier) when a dependent still exists", () => {
  const root = makeFixture({ withDependents: true })
  const rows = buildRows(root)
  const egress = rows.find((r) => r.path === "packages/egress")
  assert.ok(egress, "egress row present")
  // identity's override does not apply: @w/consumer depends on it.
  const identity = rows.find((r) => r.path === "packages/identity")
  assert.equal(identity.tier, "spec-reference", "not dead → natural spec tier")
  // egress too (its description carries no spec keywords → default core).
  const e2 = rows.find((r) => r.path === "packages/egress")
  assert.equal(e2.tier, "core", "not dead → default core tier")
})

test("renderStatus emits one row per package plus header/counts", () => {
  const rows = buildRows(makeFixture())
  const md = renderStatus(rows, { workspaceCount: rows.length })
  assert.match(md, /^# STATUS\.md — package tiers/)
  assert.match(md, /## Classification rule/)
  assert.match(md, /## Tier counts/)
  const tableRows = md.split("\n").filter((l) => l.startsWith("| @w/"))
  assert.equal(tableRows.length, rows.length)
  for (const row of rows) assert.match(tableRows.find((l) => l.includes(`| ${row.path} `)), /\|/)
})

test("sanitizeReason strips pipes and collapses newlines", () => {
  assert.equal(sanitizeReason("a|b\nc  d"), "a/b c d")
})

test("classify honors injected override/family sets", () => {
  const base = { name: "x/thing", description: "runtime glue", dependents: [] }
  assert.equal(
    classify({ ...base, dir: "packages/thing", archivedOverrides: new Set(), coreFamily: CORE_FAMILY }).tier,
    "core",
  )
  assert.equal(
    classify({
      name: "x/doom",
      dir: "packages/doom",
      description: "whatever",
      dependents: [{ name: "other" }],
      archivedOverrides: new Set(["packages/doom"]),
    }).tier,
    "spec-reference",
  )
  assert.match(SPEC_PATTERN.source, /doctype/)
  assert.equal(ARCHIVED_OVERRIDES.size, 10)
})
