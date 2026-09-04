#!/usr/bin/env node
/**
 * Tests for scripts/sync-templates.mjs — run with `node --test`.
 * Exercises the script against a throwaway fixture tree (--root) copied
 * from the repo's real templates/workstation/versions.json: idempotency
 * (second run produces no diff), --check failing after a deliberate edit
 * of a generated file, and --dry-run writing nothing.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const SCRIPT = path.join(REPO_ROOT, "scripts/sync-templates.mjs")
const REPO_VERSIONS = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "templates/workstation/versions.json"), "utf8"),
)
const STABLE_ID = REPO_VERSIONS.templates.stable.id
// The opaque template id may exist ONLY here (versions.json + the generated
// module) — asserted below; never hardcoded anywhere else.
const STABLE_ID_RE = new RegExp(STABLE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))

function makeFixture() {
  const root = mkdtempSync(path.join(import.meta.dirname, "sync-templates-fixture-"))
  mkdirSync(path.join(root, "templates/workstation"), { recursive: true })
  mkdirSync(path.join(root, "packages/sandbox-e2b/src"), { recursive: true })
  mkdirSync(path.join(root, "docs/cli/guides"), { recursive: true })
  mkdirSync(path.join(root, "packages/runtime/src/sandbox-providers"), { recursive: true })

  cpSync(
    path.join(REPO_ROOT, "templates/workstation/versions.json"),
    path.join(root, "templates/workstation/versions.json"),
  )

  writeFileSync(
    path.join(root, "packages/sandbox-e2b/README.md"),
    "# pkg\n\n<!-- sync-templates:start -->\nstale\n<!-- sync-templates:end -->\n",
  )
  writeFileSync(
    path.join(root, "docs/cli/guides/sandbox-rendezvous.md"),
    "# guide\n\n<!-- sync-templates:start -->\nstale\n<!-- sync-templates:end -->\n",
  )
  writeFileSync(
    path.join(root, "packages/runtime/src/sandbox-providers/registry.ts"),
    "const x = {\n  description:\n    /* sync-templates:start */\n    'stale',\n    /* sync-templates:end */\n}\n",
  )
  writeFileSync(
    path.join(root, "packages/runtime/src/sandbox-adapters.ts"),
    "const x = {\n  description:\n    /* sync-templates:start */\n    'stale',\n    /* sync-templates:end */\n}\n",
  )
  writeFileSync(
    path.join(root, "packages/sandbox-e2b/package.json"),
    JSON.stringify({ name: "@agentproto/sandbox-e2b", description: "stale" }, null, 2) + "\n",
  )
  return root
}

function runSync(root, ...flags) {
  return execFileSync(process.execPath, [SCRIPT, "--root", root, ...flags], {
    encoding: "utf8",
  })
}

function snapshot(root) {
  const files = [
    "packages/sandbox-e2b/src/template-versions.generated.ts",
    "templates/workstation/e2b.template.toml",
    "packages/sandbox-e2b/README.md",
    "docs/cli/guides/sandbox-rendezvous.md",
    "packages/runtime/src/sandbox-providers/registry.ts",
    "packages/runtime/src/sandbox-adapters.ts",
    "packages/sandbox-e2b/package.json",
  ]
  return Object.fromEntries(files.map(f => [f, readFileSync(path.join(root, f), "utf8")]))
}

test("write mode generates all artifacts and is idempotent (second run = no diff)", () => {
  const root = makeFixture()
  try {
    runSync(root)
    const first = snapshot(root)

    // generated module exports the canonical pins
    const gen = first["packages/sandbox-e2b/src/template-versions.generated.ts"]
    assert.match(gen, new RegExp(`export const DEFAULT_TEMPLATE = "${STABLE_ID}"`))
    assert.match(gen, /export const BAKED_CLI_VERSION = "0\.17\.0"/)
    assert.match(gen, /"@agentproto\/adapter-opencode": "1\.1\.10"/)
    assert.match(gen, /TEMPLATE_ALIASES = \{[^]*stable: "agentproto-workstation"/)

    // marked blocks rewritten with pins
    assert.match(first["packages/sandbox-e2b/README.md"], /@agentproto\/cli@0\.17\.0/)
    assert.doesNotMatch(first["packages/sandbox-e2b/README.md"], /stale/)
    assert.match(first["docs/cli/guides/sandbox-rendezvous.md"], /opencode-ai@1\.18\.28/)
    assert.match(first["packages/runtime/src/sandbox-providers/registry.ts"], /baked @agentproto\/cli 0\.17\.0/)

    // package.json description rewritten in place
    assert.match(first["packages/sandbox-e2b/package.json"], /"description": ".*baked @agentproto\/cli 0\.17\.0.*"/)

    // toml carries the build args
    assert.match(first["templates/workstation/e2b.template.toml"], /AGENTPROTO_CLI_VERSION = "0\.17\.0"/)
    // the opaque template id must NOT leak into the toml (alias only)
    assert.doesNotMatch(first["templates/workstation/e2b.template.toml"], STABLE_ID_RE)

    // SECOND run: byte-identical tree — no diff
    runSync(root)
    assert.deepEqual(snapshot(root), first)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--check exits non-zero and prints drift after a deliberate edit of a generated file", () => {
  const root = makeFixture()
  try {
    runSync(root)
    const genPath = path.join(root, "packages/sandbox-e2b/src/template-versions.generated.ts")
    writeFileSync(genPath, readFileSync(genPath, "utf8").replace("0.17.0", "9.9.9"))

    let exitCode = 0
    let stderr = ""
    try {
      execFileSync(process.execPath, [SCRIPT, "--root", root, "--check"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      exitCode = err.status
      stderr = err.stderr
    }
    assert.equal(exitCode, 1)
    assert.match(stderr, /drift/)
    assert.match(stderr, /template-versions\.generated\.ts/)

    // re-running write mode heals the drift and --check goes green again
    runSync(root)
    const out = runSync(root, "--check")
    assert.match(out, /in sync/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--check fails when a marked block is hand-edited", () => {
  const root = makeFixture()
  try {
    runSync(root)
    const readme = path.join(root, "packages/sandbox-e2b/README.md")
    writeFileSync(readme, readFileSync(readme, "utf8").replace("0.17.0", "0.0.1"))

    let exitCode = 0
    try {
      execFileSync(process.execPath, [SCRIPT, "--root", root, "--check"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      exitCode = err.status
    }
    assert.equal(exitCode, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--dry-run reports intended changes and writes nothing", () => {
  const root = makeFixture()
  try {
    const out = runSync(root, "--dry-run")
    assert.match(out, /dry-run/)
    assert.match(out, /template-versions\.generated\.ts/)
    assert.equal(existsSync(path.join(root, "packages/sandbox-e2b/src/template-versions.generated.ts")), false)
    assert.match(readFileSync(path.join(root, "packages/sandbox-e2b/README.md"), "utf8"), /stale/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("invalid versions.json fails validation with a non-zero exit", () => {
  const root = makeFixture()
  try {
    const versionsPath = path.join(root, "templates/workstation/versions.json")
    const versions = JSON.parse(readFileSync(versionsPath, "utf8"))
    versions.cli = "not-semver"
    writeFileSync(versionsPath, JSON.stringify(versions, null, 2))

    let exitCode = 0
    let stderr = ""
    try {
      execFileSync(process.execPath, [SCRIPT, "--root", root, "--check"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      exitCode = err.status
      stderr = err.stderr
    }
    assert.equal(exitCode, 1)
    assert.match(stderr, /cli: expected semver/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
