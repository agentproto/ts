#!/usr/bin/env node
/**
 * sync-templates — regenerate every derived artifact of the
 * agentproto-workstation e2b template from the canonical pin declaration
 * `templates/workstation/versions.json` (schema: versions.schema.json).
 *
 * Modeled on sync-specs.mjs. Derived artifacts owned here:
 *   - packages/sandbox-e2b/src/template-versions.generated.ts
 *   - templates/workstation/e2b.template.toml (build args from the pins,
 *     plus one create command per size preset)
 *   - marked `sync-templates` blocks in the sandbox-e2b README, the
 *     sandbox-rendezvous guide, and the two runtime e2b descriptions
 *   - marked `sync-templates:sizes` blocks (the size-preset table) in the
 *     sandbox-e2b README and templates/workstation/README.md
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
const DOCKERFILE_PATH = path.join(root, "templates/workstation/Dockerfile")
const E2B_PACKAGE_JSON_PATH = path.join(root, "packages/sandbox-e2b/package.json")

const WORKSTATION_README_PATH = path.join(root, "templates/workstation/README.md")
const E2B_README_PATH = path.join(root, "packages/sandbox-e2b/README.md")

const MARKED_FILES = [
  path.join(root, "packages/sandbox-e2b/README.md"),
  path.join(root, "docs/cli/guides/sandbox-rendezvous.md"),
  path.join(root, "packages/runtime/src/sandbox-providers/registry.ts"),
  path.join(root, "packages/runtime/src/sandbox-adapters.ts"),
]
// Files carrying a `sync-templates:sizes` block (the size-preset table).
const SIZE_MARKED_FILES = [E2B_README_PATH, WORKSTATION_README_PATH]

// --- Load + validate versions.json (hand-rolled, no runtime dependency) ---

function fail(message) {
  process.stderr.write(`sync-templates: ${message}\n`)
  process.exit(1)
}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const SIZE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

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
  const gh = v.tools?.gh
  if (typeof gh !== "object" || gh === null) fail("tools.gh: required object { version, sha256 }")
  if (typeof gh.version !== "string" || !/^\d+\.\d+\.\d+$/.test(gh.version)) {
    fail(`tools.gh.version: expected x.y.z, got ${JSON.stringify(gh.version)}`)
  }
  if (typeof gh.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(gh.sha256)) {
    fail("tools.gh.sha256: expected the 64-hex sha256 of the linux_amd64 tarball")
  }
  if ("resources" in v) fail("resources: replaced by `sizes` + `defaultSize` (named size presets)")
  const sizes = v.sizes
  if (typeof sizes !== "object" || sizes === null || Object.keys(sizes).length === 0) {
    fail("sizes: required non-empty object (preset name -> { cpuCount, memoryMb })")
  }
  for (const [name, preset] of Object.entries(sizes)) {
    if (!SIZE_NAME_RE.test(name)) fail(`sizes.${name}: preset names are lowercase kebab-case`)
    if (typeof preset !== "object" || preset === null) fail(`sizes.${name}: required object`)
    if (!Number.isInteger(preset.cpuCount) || preset.cpuCount < 1) {
      fail(`sizes.${name}.cpuCount: expected positive integer, got ${JSON.stringify(preset.cpuCount)}`)
    }
    if (!Number.isInteger(preset.memoryMb) || preset.memoryMb < 512 || preset.memoryMb % 2 !== 0) {
      fail(`sizes.${name}.memoryMb: expected even integer >= 512, got ${JSON.stringify(preset.memoryMb)}`)
    }
    if (preset.available !== undefined && typeof preset.available !== "boolean") {
      fail(`sizes.${name}.available: boolean when present`)
    }
    if (preset.available === false && (typeof preset.unavailableReason !== "string" || !preset.unavailableReason)) {
      fail(`sizes.${name}: available: false requires unavailableReason (the exact e2b error)`)
    }
    if (preset.available !== false && preset.unavailableReason !== undefined) {
      fail(`sizes.${name}.unavailableReason: only allowed with available: false`)
    }
  }
  if (typeof v.defaultSize !== "string" || !(v.defaultSize in sizes)) {
    fail(`defaultSize: must name a key of sizes (${Object.keys(sizes).join(", ")}), got ${JSON.stringify(v.defaultSize)}`)
  }
  if (sizes[v.defaultSize].available === false) fail(`defaultSize: preset ${v.defaultSize} is marked unavailable`)
  const t = v.templates
  if (typeof t !== "object" || t === null || typeof t.stable !== "object" || typeof t.dev !== "object") {
    fail("templates.stable / templates.dev: required objects")
  }
  for (const key of ["stable", "dev"]) validateTemplateEntry(t[key], `templates.${key}`)
  if (typeof t.sizes !== "object" || t.sizes === null) fail("templates.sizes: required object (one entry per sizes preset)")
  const declared = Object.keys(sizes).sort().join(",")
  if (Object.keys(t.sizes).sort().join(",") !== declared) {
    fail(`templates.sizes: keys must match sizes exactly (${Object.keys(sizes).join(", ")})`)
  }
  for (const [name, entry] of Object.entries(t.sizes)) {
    const label = `templates.sizes.${name}`
    validateTemplateEntry(entry, label)
    if (entry.alias !== `${t.stable.alias}-${name}`) fail(`${label}.alias: expected ${t.stable.alias}-${name}`)
    if (sizes[name].available === false && entry.id !== null) fail(`${label}.id: must be null for an unavailable preset`)
  }
}

function validateTemplateEntry(entry, label) {
  if (typeof entry !== "object" || entry === null) fail(`${label}: required object`)
  if (entry.id !== null && typeof entry.id !== "string") fail(`${label}.id: string or null`)
  if (typeof entry.alias !== "string" || !entry.alias) fail(`${label}.alias: required non-empty string`)
  validateBaked(entry.baked, `${label}.baked`)
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
  if (baked.tools !== undefined && baked.tools !== null) {
    if (typeof baked.tools !== "object") fail(`${label}.tools: object or null`)
    for (const [tool, ver] of Object.entries(baked.tools)) {
      if (typeof ver !== "string" || !SEMVER_RE.test(ver)) fail(`${label}.tools.${tool}: expected semver, got ${JSON.stringify(ver)}`)
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

const { cli, adapters, runtime, tools, sizes, defaultSize, templates, baseImage } = versions

// e2b `template create -d Dockerfile` builds the Dockerfile DIRECTLY and does
// NOT read this repo's e2b.template.toml (the CLI's own config file is
// `e2b.toml`; ours is a record only). Sandbox resources therefore cannot ride
// in the toml — they must be passed as CLI FLAGS at create time. The default
// is 512MB, which OOMs a heavy adapter install (mastra) at runtime. versions.json
// stays the single source; the generator threads these flags into every
// documented build command and records them in the toml. The bare stable alias
// and the dev alias are built at `defaultSize`; every preset gets its own alias.
const flagsFor = preset => `--cpu-count ${preset.cpuCount} --memory-mb ${preset.memoryMb}`
const defaultPreset = sizes[defaultSize]
const resourceFlags = flagsFor(defaultPreset)
const sizeEntries = Object.entries(sizes).map(([name, preset]) => ({
  name,
  ...preset,
  available: preset.available !== false,
  template: templates.sizes[name],
}))
const createCommand = (alias, preset) => `e2b template create ${alias} ${flagsFor(preset)} -d Dockerfile`
const adapterSpecs = Object.entries(adapters)
  .map(([pkg, ver]) => `${pkg}@${ver}`)
  .sort()

// One ARG per adapter — never a space-separated list. E2B's builder rewrites
// each ARG into an ENV and mangles any ENV value containing spaces (space →
// `=`), so a single AGENTPROTO_ADAPTERS="a b" arg silently installs only the
// first spec (verified live). Derive a deterministic, collision-free ARG name
// from the package name: drop the leading `@`, non-alphanumerics → `_`, upper.
const adapterArgName = pkg => pkg.replace(/^@/, "").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()
const adapterArgs = Object.entries(adapters)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([pkg, ver]) => ({ pkg, ver, arg: adapterArgName(pkg), spec: `${pkg}@${ver}` }))
const opencodeRuntime = runtime["opencode-ai"] ?? ""

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
/** Size preset the bare stable alias is built at and the provider boots by default. */
export const DEFAULT_SIZE = ${JSON.stringify(defaultSize)}
/**
 * Named size presets, each published as its own e2b template
 * (\`config.size\` in a sandbox spec). An unavailable preset was refused by
 * e2b at create time; \`unavailableReason\` is the exact e2b error.
 */
export const SIZES = {
${sizeEntries
  .map(
    e =>
      `  ${JSON.stringify(e.name)}: {\n` +
      `    cpuCount: ${e.cpuCount},\n` +
      `    memoryMb: ${e.memoryMb},\n` +
      `    available: ${e.available},\n` +
      (e.available ? "" : `    unavailableReason: ${JSON.stringify(e.unavailableReason)},\n`) +
      `    id: ${JSON.stringify(e.template.id)},\n` +
      `    alias: ${JSON.stringify(e.template.alias)},\n` +
      `    baked: ${JSON.stringify(e.template.baked, null, 2).split("\n").map((l, i) => (i === 0 ? l : "    " + l)).join("\n")},\n` +
      `  },`,
  )
  .join("\n")}
} as const
export type WorkstationSize = keyof typeof SIZES
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
/** Standalone binaries baked from pinned release tarballs (the GitHub CLI). */
export const BAKED_TOOLS = {
  gh: ${JSON.stringify(tools.gh.version)},
} as const
export const BAKED_BASE_IMAGE = ${JSON.stringify(baseImage)}
`

const TOML = `# agentproto-workstation e2b template build declaration.
#
# The pins live in versions.json (single source of truth) and are baked into
# the Dockerfile's ARG DEFAULTS by the generator — the e2b CLI has NO
# --build-arg (\`template build\` is deprecated; use \`e2b template create\`),
# so the values below are a human-readable RECORD of what the Dockerfile
# bakes, not arguments passed at build time. This file only names the
# template by its ALIAS — the opaque e2b template id is never hardcoded here.
#
# NOTE: this file is regenerated by \`node scripts/sync-templates.mjs\`.
# Edit versions.json (or the generator), never this file.

template_id = "${templates.stable.alias}"

description = "agentproto workstation — Node, git, pinned @agentproto/cli, baked agentproto adapters, and the OpenCode runtime"

# Sandbox runtime resources of the bare alias = the default size preset
# (versions.json → sizes.${defaultSize}). The e2b default is
# 512MB, which OOMs a heavy adapter install (e.g. mastra) — so bump both. NOTE:
# \`e2b template create -d Dockerfile\` does NOT read this file; these MUST be
# passed as CLI flags (\`--cpu-count\` / \`--memory-mb\`) at create time — see the
# build commands below and README.md. The keys here are a human-readable RECORD.
cpu_count = ${defaultPreset.cpuCount}
memory_mb = ${defaultPreset.memoryMb}

[build]
dockerfile = "Dockerfile"

# Pins baked into the Dockerfile ARG defaults (versions.json is the source).
# One entry PER PACKAGE — never a space-separated list: E2B rewrites each ARG
# into an ENV and mangles spaces in ENV values (verified live).
[build.args]
BASE_IMAGE = "${baseImage}"
AGENTPROTO_CLI_VERSION = "${cli}"
${adapterArgs.map(a => `${a.arg} = "${a.spec}"`).join("\n")}
OPENCODE_RUNTIME_VERSION = "${opencodeRuntime}"
GH_VERSION = "${tools.gh.version}"
GH_SHA256 = "${tools.gh.sha256}"

# Build (from templates/workstation/ — see README.md). The resource flags are
# REQUIRED — the toml keys above are ignored by \`template create\`.
# Bare alias (= default size ${defaultSize}):
#   ${createCommand(templates.stable.alias, defaultPreset)}
# Dev variant (same Dockerfile, different alias, default size):
#   ${createCommand(templates.dev.alias, defaultPreset)}
# One template per size preset (\`config.size\` in a sandbox spec):
${sizeEntries
  .map(e =>
    e.available
      ? `#   ${createCommand(e.template.alias, e)}`
      : `#   (unavailable — e2b refused: ${e.unavailableReason})\n#   ${createCommand(e.template.alias, e)}`,
  )
  .join("\n")}
`

// The Dockerfile is GENERATED from versions.json so the pins baked into its
// ARG defaults can never drift from the declaration. Key constraints, all
// verified live against E2B's builder:
//   - FROM is NOT parameterized (E2B does not interpolate build args into
//     FROM: `invalid image reference '${BASE_IMAGE}'`).
//   - Pins are pre-FROM ARG DEFAULTS and are NOT re-declared bare after FROM
//     (a bare re-declaration shadows the default with an EMPTY ENV).
//   - One ARG PER ADAPTER (no space-separated list — see adapterArgName).
//   - CLI + every adapter + the OpenCode runtime install in ONE `npm i -g`,
//     so nothing installed later can drop the adapters from the global tree.
const guardConds = [
  '[ -n "${AGENTPROTO_CLI_VERSION}" ]',
  ...adapterArgs.map(a => `[ -n "\${${a.arg}}" ]`),
  '[ -n "${OPENCODE_RUNTIME_VERSION}" ]',
  '[ -n "${GH_VERSION}" ]',
  '[ -n "${GH_SHA256}" ]',
].join(" \\\n  && ")
const installRefs = [
  "@agentproto/cli@${AGENTPROTO_CLI_VERSION}",
  ...adapterArgs.map(a => `\${${a.arg}}`),
  "opencode-ai@${OPENCODE_RUNTIME_VERSION}",
].join(" \\\n      ")
const adapterSmoke = adapterArgs
  .map(
    a =>
      `RUN npm ls -g --depth=0 ${a.pkg} >/dev/null \\\n` +
      `  || (echo "smoke: baked adapter missing: ${a.pkg}" && exit 1)`,
  )
  .join("\n")

const DOCKERFILE = `# GENERATED by scripts/sync-templates.mjs from templates/workstation/versions.json.
# DO NOT EDIT — edit versions.json and re-run the sync script instead.
#
# agentproto-workstation e2b template image. Build (from this directory):
#   e2b template create ${templates.stable.alias} ${resourceFlags} -d Dockerfile   # see README.md
# (the resource flags are REQUIRED — e2b.template.toml is not read by \`template create\`).
#
# The e2b CLI has NO --build-arg; the pins below are ARG DEFAULTS resolved
# from versions.json at generation time.

# One ARG per package — NEVER a space-separated list. E2B rewrites every ARG
# into an ENV, and an ENV value with spaces is mangled (space → '='), so a
# single AGENTPROTO_ADAPTERS="a b" arg silently installed hermes only and the
# per-package smoke loop passed by accident (verified live). Pre-FROM defaults
# reach the post-FROM stage ONLY if not re-declared bare after FROM.
ARG AGENTPROTO_CLI_VERSION=${cli}
${adapterArgs.map(a => `ARG ${a.arg}=${a.spec}`).join("\n")}
ARG OPENCODE_RUNTIME_VERSION=${opencodeRuntime}
ARG GH_VERSION=${tools.gh.version}
ARG GH_SHA256=${tools.gh.sha256}

# FROM is NOT parameterized — E2B does not interpolate build args into FROM
# (verified live: invalid image reference '\${BASE_IMAGE}'). Regenerated to
# match versions.json (baseImage) if it changes.
FROM ${baseImage}

ENV DEBIAN_FRONTEND=noninteractive

# Fail loudly if any pin did not propagate (empty ENV) rather than bake a
# half-empty image.
RUN ${guardConds} \\
  || (echo "smoke: pin ARGs are empty — check ARG propagation" && exit 1)

# Node + git are the workstation baseline.
RUN apt-get update \\
  && apt-get install -y --no-install-recommends curl ca-certificates git jq \\
  && rm -rf /var/lib/apt/lists/*

# Node 22 (the e2bdev base image ships Node 20; a dependency of @agentproto/cli
# declares engines >=22.19 — verified live).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
  && apt-get install -y --no-install-recommends nodejs \\
  && rm -rf /var/lib/apt/lists/*

# Baked toolchain in ONE npm invocation: pinned CLI + every adapter + the
# OpenCode runtime. A single global tree means nothing installed afterwards
# can replace it and drop the adapters (the on-boot \`npm i -g\` path in
# @agentproto/sandbox-e2b documents the same constraint).
RUN npm i -g \\
      ${installRefs}

# GitHub CLI from the official cli/cli release tarball, checked against the
# sha256 pinned in versions.json (tools.gh) — sandbox agents open PRs with
# \`gh pr create\` using the daemon-injected GH_TOKEN. After the npm layer so a
# gh bump does not re-run the npm install.
RUN curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v\${GH_VERSION}/gh_\${GH_VERSION}_linux_amd64.tar.gz" \\
  && echo "\${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \\
  && tar -xzf /tmp/gh.tar.gz -C /tmp \\
  && install -m 0755 "/tmp/gh_\${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \\
  && rm -rf /tmp/gh.tar.gz "/tmp/gh_\${GH_VERSION}_linux_amd64"

# --- Build-time smoke checks: fail the build, not a live agent turn. These
#     are NECESSARY-NOT-SUFFICIENT — E2B can report a step CACHED against a
#     stale layer, so the trusted proof is booting the published image and
#     inspecting /usr/lib/node_modules/@agentproto. ---

# 1. The pinned CLI is on PATH. \`agentproto --version\` prints e.g.
#    "agentproto ${cli} (sha, built ...)" — match the pin as a substring.
RUN agentproto --version | grep -q "\${AGENTPROTO_CLI_VERSION}" \\
  || (echo "smoke: agentproto --version does not contain \${AGENTPROTO_CLI_VERSION}" && agentproto --version && exit 1)

# 2. Every baked adapter is GLOBALLY INSTALLED. (\`agentproto adapters list\`
#    shows ENABLED adapters from config — empty on a fresh bake — so it cannot
#    prove installation here; npm ls -g can. One explicit check per adapter.)
${adapterSmoke}

# 3. The pinned GitHub CLI is on PATH.
RUN gh --version | grep -q "gh version \${GH_VERSION} " \\
  || (echo "smoke: gh --version does not report \${GH_VERSION}" && gh --version && exit 1)

# 4. The daemon boots and answers /health on the provider's default port.
RUN agentproto serve --port 18790 --bind 127.0.0.1 --workspace /home/user >/tmp/serve.log 2>&1 & \\
    SERVE_PID=$!; \\
    for i in $(seq 1 30); do \\
      curl -fsS http://127.0.0.1:18790/health >/dev/null 2>&1 && break; \\
      sleep 1; \\
    done; \\
    curl -fsS http://127.0.0.1:18790/health >/dev/null \\
      || (echo "smoke: daemon /health never came up" && cat /tmp/serve.log && kill $SERVE_PID && exit 1); \\
    kill $SERVE_PID
`

const pinList = [
  `\`@agentproto/cli@${cli}\``,
  ...adapterSpecs.map(spec => `\`${spec}\``),
  ...Object.entries(runtime)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, ver]) => `\`${pkg}@${ver}\``),
  `\`gh@${tools.gh.version}\``,
]

const README_BLOCK = `- The default \`${templates.stable.alias}\` template is declared in
  \`templates/workstation/versions.json\`: ${pinList.slice(0, 2).join(", ")}, ${pinList.slice(2).join(", ")}. The on-boot
  \`npm i -g\` is skipped by default only once the template's recorded \`baked\`
  block PROVES the image already carries the requested pin; until then the
  legacy boot install stays on.`

const DOCS_BLOCK = `The \`e2b\` provider's default template is declared in
\`templates/workstation/versions.json\`: ${pinList.join(", ")}. The on-boot CLI install is skipped only once the
template's recorded \`baked\` block proves the image carries the requested pin.`

const sizeTable = [
  "| size | vCPU | RAM (MB) | e2b alias | status |",
  "|---|---|---|---|---|",
  ...sizeEntries.map(
    e =>
      `| \`${e.name}\`${e.name === defaultSize ? " (default)" : ""} | ${e.cpuCount} | ${e.memoryMb} | \`${e.template.alias}\` | ` +
      (e.available ? "published" : `**unavailable** — e2b refused: \`${e.unavailableReason}\``) +
      " |",
  ),
].join("\n")

const SIZES_TABLE_BLOCK = `${sizeTable}

The bare \`${templates.stable.alias}\` alias (and \`${templates.dev.alias}\`) is built at
the default size, \`${defaultSize}\` (${defaultPreset.cpuCount} vCPU / ${defaultPreset.memoryMb} MB).`

const SIZES_COMMANDS_BLOCK = `${SIZES_TABLE_BLOCK}

Create commands (run from \`templates/workstation/\`; the flags are REQUIRED):

\`\`\`sh
${createCommand(templates.stable.alias, defaultPreset)}   # bare alias = ${defaultSize}
${createCommand(templates.dev.alias, defaultPreset)}   # dev channel = ${defaultSize}
${sizeEntries
  .map(e => (e.available ? "" : "# unavailable on the current e2b plan:\n# ") + createCommand(e.template.alias, e))
  .join("\n")}
\`\`\``

const TS_DESCRIPTION_BLOCK = `"Runs the agentproto daemon inside an e2b Firecracker microVM (${templates.stable.alias} template, baked @agentproto/cli ${cli}).",`

const PACKAGE_DESCRIPTION =
  `@agentproto/sandbox-e2b — e2b \`SandboxProvider\` for @agentproto/sandbox. ` +
  `Boots the pinned \`${templates.stable.alias}\` e2b template (baked @agentproto/cli ${cli}), ` +
  `starts the agentproto daemon inside it, and exposes its MCP endpoint as a URL so any ` +
  `AgentSessionHost consumer (worktreeAgentWorkflow, worktree-agent CLI) can run a coding-agent step inside the sandbox.`

// --- Compute the plan ---

// Three comment flavors, one marker vocabulary:
//   <!-- … -->   HTML, for plain markdown (sandbox-e2b README)
//   /* … */      JS block, for .ts sources
//   {/* … */}    MDX expression, for markdown that gets compiled as MDX
// docs/cli/ must stay MDX-compilable (fumadocs-mdx), and MDX rejects HTML
// comments outright — so files under docs/cli/ must use the `{/* … */}` flavor.
const markerStartRe = tag =>
  new RegExp(`^[ \\t]*(?:<!--|\\{\\/\\*|\\/\\*) ${tag}:start (?:-->|\\*\\/\\}|\\*\\/)[ \\t]*\\n`, "m")
const markerEndRe = tag =>
  new RegExp(`\\n[ \\t]*(?:<!--|\\{\\/\\*|\\/\\*) ${tag}:end (?:-->|\\*\\/\\}|\\*\\/)`)

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
planFile(DOCKERFILE_PATH, DOCKERFILE)

// Marked blocks: replace everything between the start/end markers.
function replaceMarked(current, tag, body, filePath) {
  const startRe = markerStartRe(tag)
  const start = current.search(startRe)
  if (start === -1) {
    fail(`missing ${tag}:start marker in ${path.relative(root, filePath)}`)
  }
  const startMatch = current.slice(start).match(startRe)
  const indent = startMatch[0].match(/^[ \t]*/)[0]
  const bodyStart = start + startMatch[0].length
  const endMatch = current.slice(bodyStart).match(markerEndRe(tag))
  if (!endMatch) {
    fail(`missing ${tag}:end marker in ${path.relative(root, filePath)}`)
  }
  const indentedBody = body
    .split("\n")
    .map(line => (line ? indent + line : line))
    .join("\n")
  return current.slice(0, bodyStart) + indentedBody + current.slice(bodyStart + endMatch.index)
}

for (const filePath of new Set([...MARKED_FILES, ...SIZE_MARKED_FILES])) {
  if (!existsSync(filePath)) continue // marked file not present in this tree
  const current = readFileSync(filePath, "utf8")
  let next = current
  if (MARKED_FILES.includes(filePath)) {
    const body = path.basename(filePath) === "registry.ts" || path.basename(filePath) === "sandbox-adapters.ts"
      ? TS_DESCRIPTION_BLOCK
      : path.basename(filePath) === "README.md"
        ? README_BLOCK
        : DOCS_BLOCK
    next = replaceMarked(next, "sync-templates", body, filePath)
  }
  if (SIZE_MARKED_FILES.includes(filePath)) {
    const body = filePath === WORKSTATION_README_PATH ? SIZES_COMMANDS_BLOCK : SIZES_TABLE_BLOCK
    next = replaceMarked(next, "sync-templates:sizes", body, filePath)
  }
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
