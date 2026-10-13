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

// The pins under test are derived from the same versions.json the fixture
// copies — hardcoding them here breaks the test on every pin bump.
const CLI = REPO_VERSIONS.cli
const ADAPTER_OPENCODE = REPO_VERSIONS.adapters["@agentproto/adapter-opencode"]
const ADAPTER_HERMES = REPO_VERSIONS.adapters["@agentproto/adapter-hermes"]
const ADAPTER_MASTRA = REPO_VERSIONS.adapters["@agentproto/adapter-mastra-agent"]
const OPENCODE_RUNTIME = REPO_VERSIONS.runtime["opencode-ai"]
const DEFAULT_SIZE = REPO_VERSIONS.defaultSize
const DEFAULT_PRESET = REPO_VERSIONS.sizes[DEFAULT_SIZE]
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

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
    "# pkg\n\n<!-- sync-templates:sizes:start -->\nstale\n<!-- sync-templates:sizes:end -->\n\n<!-- sync-templates:start -->\nstale\n<!-- sync-templates:end -->\n",
  )
  // MDX comment flavor on purpose — docs/cli/ must stay MDX-compilable
  // (fumadocs-mdx), which rejects `<!-- -->`.
  writeFileSync(
    path.join(root, "docs/cli/guides/sandbox-rendezvous.md"),
    "# guide\n\n{/* sync-templates:start */}\nstale\n{/* sync-templates:end */}\n",
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
    path.join(root, "templates/workstation/README.md"),
    "# ws\n\n<!-- sync-templates:sizes:start -->\nstale\n<!-- sync-templates:sizes:end -->\n",
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
    "templates/workstation/Dockerfile",
    "templates/workstation/README.md",
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
    assert.match(gen, new RegExp(`export const BAKED_CLI_VERSION = "${esc(CLI)}"`))
    assert.match(gen, new RegExp(`"@agentproto/adapter-opencode": "${esc(ADAPTER_OPENCODE)}"`))
    assert.match(gen, /TEMPLATE_ALIASES = \{[^]*stable: "agentproto-workstation"/)

    // marked blocks rewritten with pins
    assert.match(first["packages/sandbox-e2b/README.md"], new RegExp(`@agentproto/cli@${esc(CLI)}`))
    assert.doesNotMatch(first["packages/sandbox-e2b/README.md"], /stale/)
    assert.match(first["docs/cli/guides/sandbox-rendezvous.md"], new RegExp(`opencode-ai@${esc(OPENCODE_RUNTIME)}`))
    assert.match(first["packages/runtime/src/sandbox-providers/registry.ts"], new RegExp(`baked @agentproto/cli ${esc(CLI)}`))

    // package.json description rewritten in place
    assert.match(first["packages/sandbox-e2b/package.json"], new RegExp(`"description": ".*baked @agentproto/cli ${esc(CLI)}.*"`))

    // toml records the pins per-package (no space-separated adapter list)
    const toml = first["templates/workstation/e2b.template.toml"]
    assert.match(toml, new RegExp(`AGENTPROTO_CLI_VERSION = "${esc(CLI)}"`))
    assert.doesNotMatch(toml, /AGENTPROTO_ADAPTERS =/)
    // the opaque template id must NOT leak into the toml (alias only)
    assert.doesNotMatch(toml, STABLE_ID_RE)
    // resources recorded from versions.json, and threaded into the documented
    // build command as CLI FLAGS (the toml itself is not read by `template create`).
    // The bare alias records the DEFAULT size preset.
    assert.match(toml, new RegExp(`cpu_count = ${DEFAULT_PRESET.cpuCount}\n`))
    assert.match(toml, new RegExp(`memory_mb = ${DEFAULT_PRESET.memoryMb}\n`))
    assert.match(
      toml,
      new RegExp(`create agentproto-workstation --cpu-count ${DEFAULT_PRESET.cpuCount} --memory-mb ${DEFAULT_PRESET.memoryMb} -d Dockerfile`),
    )
    // ...and one create command per size preset, each with its own flags.
    for (const [name, preset] of Object.entries(REPO_VERSIONS.sizes)) {
      assert.match(
        toml,
        new RegExp(`create agentproto-workstation-${esc(name)} --cpu-count ${preset.cpuCount} --memory-mb ${preset.memoryMb} -d Dockerfile`),
      )
    }

    // size tables: both READMEs list every preset; only the workstation README
    // carries the create commands. Unavailable presets show the e2b error.
    const wsReadme = first["templates/workstation/README.md"]
    const pkgReadme = first["packages/sandbox-e2b/README.md"]
    for (const readme of [wsReadme, pkgReadme]) {
      assert.doesNotMatch(readme.split("sync-templates:start")[0], /stale/)
      for (const [name, preset] of Object.entries(REPO_VERSIONS.sizes)) {
        assert.match(readme, new RegExp(`\\| \`${esc(name)}\`[^|]*\\| ${preset.cpuCount} \\| ${preset.memoryMb} \\|`))
        if (preset.available === false) assert.ok(readme.includes(preset.unavailableReason))
      }
      assert.match(readme, new RegExp(`\`${esc(DEFAULT_SIZE)}\` \\(default\\)`))
      assert.doesNotMatch(readme, STABLE_ID_RE)
    }
    assert.match(wsReadme, /e2b template create agentproto-workstation-dev /)
    assert.doesNotMatch(pkgReadme, /e2b template create/)

    // generated module: one SIZES entry per preset + the default size
    assert.match(gen, new RegExp(`export const DEFAULT_SIZE = "${esc(DEFAULT_SIZE)}"`))
    for (const [name, preset] of Object.entries(REPO_VERSIONS.sizes)) {
      assert.match(gen, new RegExp(`"${esc(name)}": \\{\\n    cpuCount: ${preset.cpuCount},\\n    memoryMb: ${preset.memoryMb},\\n    available: ${preset.available !== false},`))
    }
    assert.match(gen, /export type WorkstationSize = keyof typeof SIZES/)

    // Dockerfile: one ARG per adapter (never a space-separated list), pins
    // baked as ARG defaults, and a SINGLE `npm i -g` for the baked toolchain
    // (so nothing installed later can drop the adapters).
    const df = first["templates/workstation/Dockerfile"]
    assert.match(df, new RegExp(`ARG AGENTPROTO_ADAPTER_HERMES=@agentproto/adapter-hermes@${esc(ADAPTER_HERMES)}`))
    assert.match(df, new RegExp(`ARG AGENTPROTO_ADAPTER_OPENCODE=@agentproto/adapter-opencode@${esc(ADAPTER_OPENCODE)}`))
    // mastra-agent adapter: its own ARG + npm ls -g smoke line (derived from
    // versions.json, so the arg name is the sanitized upper-cased package name).
    assert.match(df, new RegExp(`ARG AGENTPROTO_ADAPTER_MASTRA_AGENT=@agentproto/adapter-mastra-agent@${esc(ADAPTER_MASTRA)}`))
    assert.match(df, /npm ls -g --depth=0 @agentproto\/adapter-mastra-agent/)
    assert.match(df, new RegExp(`ARG AGENTPROTO_CLI_VERSION=${esc(CLI)}`))
    // no space-separated adapter ARG declaration (anchored to a real ARG line,
    // not the explanatory comment that names the anti-pattern)
    assert.doesNotMatch(df, /^ARG [A-Z_]*ADAPTERS=/m)
    assert.equal((df.match(/^RUN npm i -g/gm) || []).length, 1)
    // gh: pinned release tarball, checksum-verified, smoke-checked
    assert.match(df, new RegExp(`^ARG GH_VERSION=${esc(REPO_VERSIONS.tools.gh.version)}$`, "m"))
    assert.match(df, new RegExp(`^ARG GH_SHA256=${REPO_VERSIONS.tools.gh.sha256}$`, "m"))
    assert.match(df, /sha256sum -c -/)
    assert.match(df, /^RUN gh --version \| grep -q "gh version \$\{GH_VERSION\} "/m)
    assert.match(toml, new RegExp(`GH_VERSION = "${esc(REPO_VERSIONS.tools.gh.version)}"`))
    assert.match(gen, new RegExp(`BAKED_TOOLS = \\{\\n  gh: "${esc(REPO_VERSIONS.tools.gh.version)}",`))
    // no bare post-FROM ARG re-declaration would shadow the pre-FROM defaults
    assert.doesNotMatch(df, /\nARG AGENTPROTO_CLI_VERSION\n/)

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
    writeFileSync(genPath, readFileSync(genPath, "utf8").replace(CLI, "9.9.9"))

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
    writeFileSync(readme, readFileSync(readme, "utf8").replace(CLI, "0.0.1"))

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

function expectInvalid(mutate, messageRe) {
  const root = makeFixture()
  try {
    const versionsPath = path.join(root, "templates/workstation/versions.json")
    const versions = JSON.parse(readFileSync(versionsPath, "utf8"))
    mutate(versions)
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
    assert.match(stderr, messageRe)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("size presets are validated: defaultSize, availability, and the per-size template entries", () => {
  expectInvalid(v => { v.defaultSize = "huge" }, /defaultSize: must name a key of sizes/)
  expectInvalid(v => { v.sizes[v.defaultSize].available = false; v.sizes[v.defaultSize].unavailableReason = "x" }, /defaultSize: preset .* is marked unavailable/)
  expectInvalid(v => { v.sizes.nano.available = false }, /available: false requires unavailableReason/)
  expectInvalid(v => { v.sizes.nano.unavailableReason = "x" }, /unavailableReason: only allowed with available: false/)
  expectInvalid(v => { v.sizes.nano.memoryMb = 1023 }, /sizes\.nano\.memoryMb: expected even integer/)
  expectInvalid(v => { delete v.templates.sizes.nano }, /templates\.sizes: keys must match sizes exactly/)
  expectInvalid(v => { v.templates.sizes.nano.alias = "other" }, /templates\.sizes\.nano\.alias: expected agentproto-workstation-nano/)
  expectInvalid(v => { v.tools.gh.sha256 = "nope" }, /tools\.gh\.sha256: expected the 64-hex sha256/)
  expectInvalid(v => { delete v.tools }, /tools\.gh: required object/)
  expectInvalid(v => { v.resources = { cpuCount: 2, memoryMb: 4096 } }, /resources: replaced by `sizes`/)
  expectInvalid(
    v => { v.sizes.nano.available = false; v.sizes.nano.unavailableReason = "e2b said no"; v.templates.sizes.nano.id = "abcdefghijklmnopqrst" },
    /templates\.sizes\.nano\.id: must be null for an unavailable preset/,
  )
})
