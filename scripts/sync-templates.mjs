#!/usr/bin/env node
/**
 * sync-templates — regenerate every derived artifact of the
 * agentproto-workstation e2b template from the canonical pin declaration
 * `templates/workstation/versions.json` (schema: versions.schema.json).
 *
 * Modeled on sync-specs.mjs. Derived artifacts owned here:
 *   - packages/sandbox-e2b/src/template-versions.generated.ts
 *   - templates/workstation/e2b.template.toml (build args from the pins)
 *   - marked `sync-templates` blocks in the sandbox-e2b README, the
 *     sandbox-rendezvous guide, and the two runtime e2b descriptions
 *   - @agentproto/sandbox-e2b's package.json `description`
 *
 * Usage:
 *   node scripts/sync-templates.mjs            # write
 *   node scripts/sync-templates.mjs --check    # exit 1 + drift report if stale
 *   node scripts/sync-templates.mjs --dry-run  # print intended changes, no writes
 *   node scripts/sync-templates.mjs --root <dir>  # operate on another tree (tests)
 *
 * The opaque e2b template id is allowed to exist ONLY in versions.json and
 * the generated TS module — every other artifact references the alias.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_ROOT = path.resolve(__dirname, "..")

const args = process.argv.slice(2)
let root = DEFAULT_ROOT
let mode = "write" // "write" | "check" | "dry"
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--root") root = path.resolve(args[++i])
  else if (a === "--check") mode = "check"
  else if (a === "--dry-run") mode = "dry"
  else if (a === "--help" || a === "-h") {
    process.stdout.write("Usage: sync-templates.mjs [--root <dir>] [--check | --dry-run]\n")
    process.exit(0)
  } else {
    process.stderr.write(`sync-templates: unknown argument ${a}\n`)
    process.exit(2)
  }
}

const VERSIONS_PATH = path.join(root, "templates/workstation/versions.json")
const GENERATED_TS_PATH = path.join(root, "packages/sandbox-e2b/src/template-versions.generated.ts")
const TOML_PATH = path.join(root, "templates/workstation/e2b.template.toml")
const E2B_PACKAGE_JSON_PATH = path.join(root, "packages/sandbox-e2b/package.json")

const MARKED_FILES = [
  path.join(root, "packages/sandbox-e2b/README.md"),
  path.join(root, "docs/cli/guides/sandbox-rendezvous.md"),
  path.join(root, "packages/runtime/src/sandbox-providers/registry.ts"),
  path.join(root, "packages/runtime/src/sandbox-adapters.ts"),
]

// --- Load + validate versions.json (hand-rolled, no runtime dependency) ---

function fail(message) {
  process.stderr.write(`sync-templates: ${message}\n`)
  process.exit(1)
}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function validateVersions(v) {
  if (typeof v !== "object" || v === null) fail(`${VERSIONS_PATH}: not a JSON object`)
  if (typeof v.baseImage !== "string" || !v.baseImage) fail("baseImage: required non-empty string")
  if (typeof v.cli !== "string" || !SEMVER_RE.test(v.cli)) fail(`cli: expected semver, got ${JSON.stringify(v.cli)}`)
  if (typeof v.adapters !== "object" || v.adapters === null) fail("adapters: required object")
  if (typeof v.runtime !== "object" || v.runtime === null) fail("runtime: required object")
  for (const [group, pins] of [["adapters", v.adapters], ["runtime", v.runtime]]) {
    for (const [pkg, ver] of Object.entries(pins)) {
      if (typeof ver !== "string" || !SEMVER_RE.test(ver)) {
        fail(`${group}.${pkg}: expected semver, got ${JSON.stringify(ver)}`)
      }
    }
  }
  const t = v.templates
  if (typeof t !== "object" || t === null || typeof t.stable !== "object" || typeof t.dev !== "object") {
    fail("templates.stable / templates.dev: required objects")
  }
  for (const key of ["stable", "dev"]) {
    const entry = t[key]
    if (entry.id !== null && typeof entry.id !== "string") fail(`templates.${key}.id: string or null`)
    if (typeof entry.alias !== "string" || !entry.alias) fail(`templates.${key}.alias: required non-empty string`)
    validateBaked(entry.baked, `templates.${key}.baked`)
  }
}

function validateBaked(baked, label) {
  if (typeof baked !== "object" || baked === null) fail(`${label}: required object`)
  for (const field of ["cli", "adapters", "builtAt"]) {
    if (!(field in baked)) fail(`${label}.${field}: required (use null when unknown)`)
  }
  if (baked.cli !== null && !SEMVER_RE.test(baked.cli)) {
    fail(`${label}.cli: expected semver or null, got ${JSON.stringify(baked.cli)}`)
  }
  if (baked.adapters !== null) {
    if (typeof baked.adapters !== "object") fail(`${label}.adapters: object or null`)
    for (const [pkg, ver] of Object.entries(baked.adapters)) {
      if (typeof ver !== "string" || !SEMVER_RE.test(ver)) {
        fail(`${label}.adapters.${pkg}: expected semver, got ${JSON.stringify(ver)}`)
      }
    }
  }
  if (baked.builtAt !== null && Number.isNaN(Date.parse(baked.builtAt))) {
    fail(`${label}.builtAt: expected ISO 8601 date or null`)
  }
}

if (!existsSync(VERSIONS_PATH)) fail(`pin declaration not found: ${VERSIONS_PATH}`)
let versions
try {
  versions = JSON.parse(readFileSync(VERSIONS_PATH, "utf8"))
} catch (err) {
  fail(`${VERSIONS_PATH}: invalid JSON — ${err.message}`)
}
validateVersions(versions)

const { cli, adapters, runtime, templates, baseImage } = versions
const adapterSpecs = Object.entries(adapters)
  .map(([pkg, ver]) => `${pkg}@${ver}`)
  .sort()

// --- Generated artifact contents ---

const GENERATED_TS = `/**
 * GENERATED by scripts/sync-templates.mjs from templates/workstation/versions.json.
 * DO NOT EDIT — edit versions.json and re-run the sync script instead.
 */

/** Published stable e2b template id baked with the pins below. */
export const DEFAULT_TEMPLATE = "${templates.stable.id}"
export const TEMPLATE_ALIASES = {
  stable: ${JSON.stringify(templates.stable.alias)},
  dev: ${JSON.stringify(templates.dev.alias)},
} as const
/**
 * What each published image was PROVEN to contain at its last real e2b
 * build. A null field means unknown (e.g. out-of-band bake) — consumers
 * must assume the image does NOT match the declared pins.
 */
export const TEMPLATES = {
  stable: {
    id: ${JSON.stringify(templates.stable.id)},
    alias: ${JSON.stringify(templates.stable.alias)},
    baked: ${JSON.stringify(templates.stable.baked, null, 2).split("\n").map((l, i) => (i === 0 ? l : "    " + l)).join("\n")},
  },
  dev: {
    id: ${JSON.stringify(templates.dev.id)},
    alias: ${JSON.stringify(templates.dev.alias)},
    baked: ${JSON.stringify(templates.dev.baked, null, 2).split("\n").map((l, i) => (i === 0 ? l : "    " + l)).join("\n")},
  },
} as const
export const BAKED_CLI_VERSION = "${cli}"
export const BAKED_ADAPTERS = {
${Object.entries(adapters)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([pkg, ver]) => `  ${JSON.stringify(pkg)}: "${ver}",`)
  .join("\n")}
} as const
export const BAKED_RUNTIME = {
${Object.entries(runtime)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([pkg, ver]) => `  ${JSON.stringify(pkg)}: "${ver}",`)
  .join("\n")}
} as const
export const BAKED_BASE_IMAGE = ${JSON.stringify(baseImage)}
`

const TOML = `# agentproto-workstation e2b template build declaration.
#
# Consumed by \`e2b template build\` (run from templates/workstation/ — see
# README.md in this directory for build / publish / rollback commands).
# The pins themselves live in versions.json (single source of truth); the
# Dockerfile reads them via build args. This file only names the template
# by its ALIAS — the opaque e2b template id is never hardcoded here, it is
# passed at build time / looked up from versions.json.
#
# NOTE: this file is regenerated by \`node scripts/sync-templates.mjs\`.
# Edit versions.json (or the generator), never this file.

template_id = "${templates.stable.alias}"

description = "agentproto workstation — Node, git, pinned @agentproto/cli, baked agentproto adapters, and the OpenCode runtime"

[build]
dockerfile = "Dockerfile"

# Base image for the workstation (versions.json: baseImage).
[build.args]
BASE_IMAGE = "${baseImage}"
AGENTPROTO_CLI_VERSION = "${cli}"
AGENTPROTO_ADAPTERS = "${adapterSpecs.join(" ")}"
OPENCODE_RUNTIME_VERSION = "${runtime["opencode-ai"] ?? ""}"

# Dev variant (unreleased pins, different template alias):
#   e2b template build --template-id ${templates.dev.alias} \\
#     --dockerfile Dockerfile \\
#     --build-arg AGENTPROTO_CLI_VERSION=<dev-pin> ...
`

const pinList = [
  `\`@agentproto/cli@${cli}\``,
  ...adapterSpecs.map(spec => `\`${spec}\``),
  ...Object.entries(runtime)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, ver]) => `\`${pkg}@${ver}\``),
]

const README_BLOCK = `- The default \`${templates.stable.alias}\` template is declared in
  \`templates/workstation/versions.json\`: ${pinList.slice(0, 2).join(", ")}, ${pinList.slice(2).join(", ")}. The on-boot
  \`npm i -g\` is skipped by default only once the template's recorded \`baked\`
  block PROVES the image already carries the requested pin; until then the
  legacy boot install stays on.`

const DOCS_BLOCK = `The \`e2b\` provider's default template is declared in
\`templates/workstation/versions.json\`: ${pinList.join(", ")}. The on-boot CLI install is skipped only once the
template's recorded \`baked\` block proves the image carries the requested pin.`

const TS_DESCRIPTION_BLOCK = `"Runs the agentproto daemon inside an e2b Firecracker microVM (${templates.stable.alias} template, baked @agentproto/cli ${cli}).",`

const PACKAGE_DESCRIPTION =
  `@agentproto/sandbox-e2b — e2b \`SandboxProvider\` for @agentproto/sandbox. ` +
  `Boots the pinned \`${templates.stable.alias}\` e2b template (baked @agentproto/cli ${cli}), ` +
  `starts the agentproto daemon inside it, and exposes its MCP endpoint as a URL so any ` +
  `AgentSessionHost consumer (worktreeAgentWorkflow, worktree-agent CLI) can run a coding-agent step inside the sandbox.`

// --- Compute the plan ---

const MARKER_START_RE = /^[ \t]*(?:<!--|\/\*) sync-templates:start (?:-->|\*\/)[ \t]*\n/m
const MARKER_END_RE = /\n[ \t]*(?:<!--|\/\*) sync-templates:end (?:-->|\*\/)/

const plans = []
function planFile(filePath, nextContent) {
  if (!existsSync(filePath)) {
    plans.push({ filePath, kind: "create", nextContent })
    return
  }
  const current = readFileSync(filePath, "utf8")
  if (current !== nextContent) plans.push({ filePath, kind: "rewrite", nextContent })
}

planFile(GENERATED_TS_PATH, GENERATED_TS)
planFile(TOML_PATH, TOML)

// Marked blocks: replace everything between the start/end markers.
for (const filePath of MARKED_FILES) {
  if (!existsSync(filePath)) continue // marked file not present in this tree
  const current = readFileSync(filePath, "utf8")
  const start = current.search(MARKER_START_RE)
  if (start === -1) {
    fail(`missing sync-templates:start marker in ${path.relative(root, filePath)}`)
  }
  const startMatch = current.slice(start).match(MARKER_START_RE)
  const indent = startMatch[0].match(/^[ \t]*/)[0]
  const bodyStart = start + startMatch[0].length
  const endMatch = current.slice(bodyStart).match(MARKER_END_RE)
  if (!endMatch) {
    fail(`missing sync-templates:end marker in ${path.relative(root, filePath)}`)
  }
  const body = path.basename(filePath) === "registry.ts" || path.basename(filePath) === "sandbox-adapters.ts"
    ? TS_DESCRIPTION_BLOCK
    : path.basename(filePath) === "README.md"
      ? README_BLOCK
      : DOCS_BLOCK
  const indentedBody = body
    .split("\n")
    .map(line => indent + line)
    .join("\n")
  const next =
    current.slice(0, bodyStart) +
    indentedBody +
    current.slice(bodyStart + endMatch.index)
  if (next !== current) plans.push({ filePath, kind: "rewrite", nextContent: next })
}

// package.json description (regex-replace the value; keeps the rest of the
// file byte-identical — no parse/reformat).
if (existsSync(E2B_PACKAGE_JSON_PATH)) {
  const current = readFileSync(E2B_PACKAGE_JSON_PATH, "utf8")
  const descRe = /("description"\s*:\s*")(?:[^"\\]|\\.)*(")/
  if (!descRe.test(current)) {
    fail(`no "description" field found in ${path.relative(root, E2B_PACKAGE_JSON_PATH)}`)
  }
  const next = current.replace(descRe, `$1${PACKAGE_DESCRIPTION.replace(/\\/g, "\\\\")}$2`)
  if (next !== current) plans.push({ filePath: E2B_PACKAGE_JSON_PATH, kind: "rewrite", nextContent: next })
}

// --- Act ---

function rel(p) {
  return path.relative(root, p)
}

if (plans.length === 0) {
  if (mode === "check") process.stdout.write("sync-templates: generated template artifacts in sync.\n")
  else process.stdout.write("sync-templates: generated template artifacts already in sync.\n")
  process.exit(0)
}

if (mode === "check") {
  process.stderr.write(
    `sync-templates --check: generated template artifacts drift from ${rel(VERSIONS_PATH)}\n` +
      plans.map(p => `  ${p.kind === "create" ? "+" : "~"} ${rel(p.filePath)}`).join("\n") +
      `\nRe-run scripts/sync-templates.mjs (no --check) to refresh.\n`,
  )
  process.exit(1)
}

if (mode === "dry") {
  process.stdout.write(`sync-templates (dry-run): ${plans.length} file(s) to write\n`)
  for (const p of plans) process.stdout.write(`  ${p.kind === "create" ? "+" : "~"} ${rel(p.filePath)}\n`)
  process.exit(0)
}

for (const p of plans) {
  mkdirSync(path.dirname(p.filePath), { recursive: true })
  writeFileSync(p.filePath, p.nextContent)
}
process.stdout.write(`sync-templates: wrote ${plans.length} file(s):\n`)
for (const p of plans) process.stdout.write(`  ${p.kind === "create" ? "+" : "~"} ${rel(p.filePath)}\n`)
