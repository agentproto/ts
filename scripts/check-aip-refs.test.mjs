import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { checkAipRefs, checkReadmeTable } from "./check-aip-refs.mjs"

const SCRIPT = resolve(fileURLToPath(new URL(".", import.meta.url)), "check-aip-refs.mjs")

/** Isolated { sourceRoot, scanRoot } fixture pair under a fresh tmp dir, so
 *  these tests never scan this repo's real source tree or read its real
 *  specs/meta.json. `specPackages` optionally writes a minimal
 *  `specs/aip-<n>.mdx` with a `package:` frontmatter field (or, for the
 *  "no package field" case, pass `null` to write a draft with none).
 *  `readme` optionally writes `scanRoot/README.md`. `packageJsons` optionally
 *  writes `scanRoot/packages/<name>/package.json` for the umbrella-package
 *  dependency check. */
function makeFixture(t, { pages, files, specPackages = {}, readme, packageJsons = {} }) {
  const tmp = mkdtempSync(join(tmpdir(), "check-aip-refs-test-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const sourceRoot = join(tmp, "source")
  mkdirSync(join(sourceRoot, "specs"), { recursive: true })
  writeFileSync(join(sourceRoot, "specs", "meta.json"), JSON.stringify({ pages }))
  for (const [n, pkg] of Object.entries(specPackages)) {
    const frontmatter = pkg === null ? "---\naip: ${n}\n---\n".replace("${n}", n) : `---\naip: ${n}\npackage: "${pkg}"\n---\n`
    writeFileSync(join(sourceRoot, "specs", `aip-${n}.mdx`), frontmatter)
  }

  const scanRoot = join(tmp, "scan")
  for (const [relPath, contents] of Object.entries(files)) {
    const full = join(scanRoot, relPath)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, contents)
  }
  if (readme !== undefined) {
    mkdirSync(scanRoot, { recursive: true })
    writeFileSync(join(scanRoot, "README.md"), readme)
  }
  for (const [name, pkgJson] of Object.entries(packageJsons)) {
    const dir = join(scanRoot, "packages", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson))
  }

  return { sourceRoot, scanRoot }
}

test("passes when every AIP-N reference resolves and no 'no AIP' phrase remains", (t) => {
  const { sourceRoot, scanRoot } = makeFixture(t, {
    pages: ["index", "aip-1", "aip-65"],
    files: {
      "packages/runtime/src/decision-policy.ts": "// DECISION.md is specified by AIP-65.\n",
    },
  })
  const result = checkAipRefs({ sourceRoot, scanRoot, scanDirs: ["packages"] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.unresolved, [])
  assert.deepEqual(result.warnings, [])
})

test("fails on an AIP-N reference the canonical registry doesn't know", (t) => {
  const { sourceRoot, scanRoot } = makeFixture(t, {
    pages: ["index", "aip-1"],
    files: {
      "packages/runtime/src/decision-policy.ts": "// See AIP-65 for the schema.\n",
    },
  })
  const result = checkAipRefs({ sourceRoot, scanRoot, scanDirs: ["packages"] })
  assert.equal(result.ok, false)
  assert.equal(result.unresolved.length, 1)
  assert.match(result.unresolved[0], /AIP-65 does not resolve/)
})

test("warns (without failing) on a stale 'no AIP' claim", (t) => {
  const { sourceRoot, scanRoot } = makeFixture(t, {
    pages: ["index", "aip-1", "aip-65"],
    files: {
      "packages/runtime/src/decision-policy.ts": "// there is no AIP for decision policies yet\n",
    },
  })
  const result = checkAipRefs({ sourceRoot, scanRoot, scanDirs: ["packages"] })
  assert.equal(result.ok, true)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /no AIP for decision policies/)
})

test("checkReadmeTable passes when a row's package matches canonical", (t) => {
  const { sourceRoot, scanRoot } = makeFixture(t, {
    pages: ["index", "aip-65"],
    files: {},
    specPackages: { 65: "@agentproto/runtime" },
    readme: "| AIP | Spec | Package |\n|---|---|---|\n| AIP-65 | DECISION.md | `@agentproto/runtime` |\n",
  })
  assert.deepEqual(checkReadmeTable({ scanRoot, sourceRoot }), [])
})

test("checkReadmeTable flags a row whose package drifted from canonical", (t) => {
  const { sourceRoot, scanRoot } = makeFixture(t, {
    pages: ["index", "aip-65"],
    files: {},
    specPackages: { 65: "@agentproto/runtime" },
    readme: "| AIP | Spec | Package |\n|---|---|---|\n| AIP-65 | DECISION.md | `@agentproto/decision` |\n",
  })
  const mismatches = checkReadmeTable({ scanRoot, sourceRoot })
  assert.equal(mismatches.length, 1)
  assert.match(mismatches[0], /AIP-65 table row lists.*but the canonical spec names package "@agentproto\/runtime"/)
})

test("checkReadmeTable does not flag an umbrella package that depends on the canonical one", (t) => {
  const { sourceRoot, scanRoot } = makeFixture(t, {
    pages: ["index", "aip-10"],
    specPackages: { 10: "@agentproto/knowledge" },
    readme: "| AIP | Spec | Package |\n|---|---|---|\n| AIP-10 | KNOWLEDGE.md | `@agentproto/corpus` |\n",
    packageJsons: { corpus: { dependencies: { "@agentproto/knowledge": "workspace:*" } } },
    files: {},
  })
  assert.deepEqual(checkReadmeTable({ scanRoot, sourceRoot }), [])
})

test("checkReadmeTable skips a row whose canonical spec has no package field", (t) => {
  const { sourceRoot, scanRoot } = makeFixture(t, {
    pages: ["index", "aip-66"],
    specPackages: { 66: null },
    readme: "| AIP | Spec | Package |\n|---|---|---|\n| AIP-66 | Managed cloud agents | `@agentproto/runtime` |\n",
    files: {},
  })
  assert.deepEqual(checkReadmeTable({ scanRoot, sourceRoot }), [])
})

test("the CLI reports README mismatches but they never affect the exit code", (t) => {
  const { sourceRoot, scanRoot } = makeFixture(t, {
    pages: ["index", "aip-65"],
    specPackages: { 65: "@agentproto/runtime" },
    readme: "| AIP | Spec | Package |\n|---|---|---|\n| AIP-65 | DECISION.md | `@agentproto/decision` |\n",
    files: {},
  })
  const res = spawnSync(process.execPath, [SCRIPT, "--source", sourceRoot, "--scan-root", scanRoot], {
    encoding: "utf8",
  })
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.match(res.stdout, /README\.md table row\(s\) out of sync/)
})
