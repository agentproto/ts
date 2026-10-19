#!/usr/bin/env node
/**
 * Generate STATUS.md: a tier-classified table of every workspace package.
 *
 * Tiers: core / adapters / spec-reference / archived.
 *
 * Usage:
 *   node scripts/gen-status.mjs           regenerate STATUS.md
 *   node scripts/gen-status.mjs --check   exit 0 if STATUS.md is up to date, 1 otherwise
 *   node scripts/gen-status.mjs --count   print the number of workspace package.json files
 *
 * No new dependencies: plain Node (fs/path + a hand-rolled expansion of the
 * pnpm-workspace.yaml globs).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const STATUS_PATH = join(ROOT, "STATUS.md")

/** Tier order used when rendering the table. */
export const TIERS = ["core", "adapters", "spec-reference", "archived"]

/**
 * Explicit override map: package dir (relative to repo root) -> intended
 * `archived` tier. classify() re-verifies at generation time that each
 * override is actually dead (zero workspace dependents); a non-dead override
 * keeps its natural tier instead.
 */
export const ARCHIVED_OVERRIDES = new Set([
  "packages/driver/sdk", // AIP-33 SDK provider specialisation, deprecated
  "packages/adapter-kit", // DEPRECATED — stub re-exporting @agentproto/provider-kit
  "packages/workflow-ai-sdk", // Vercel AI SDK projection of AIP-15, dormant
  "packages/egress", // egress-control prototype, dormant
  "packages/identity", // AIP-23, superseded by persona/role doctypes
  "packages/lifecycle", // AIP-37 vocabulary prototype, dormant
  "packages/catalog", // agentcatalog/v1 prototype, dormant
  "packages/role-catalog", // AIP-47 builtin role catalogue, dormant
  "adapters/ai-sdk", // Vercel AI SDK tool adapter, dormant
  "adapters/mastra", // generic Mastra tool adapter, dormant
])

/** One-line reasons for the archived overrides (keyed by dir). */
export const ARCHIVED_REASONS = new Map([
  ["packages/driver/sdk", "deprecated AIP-33 SDK provider specialisation; 0 workspace dependents"],
  ["packages/adapter-kit", "DEPRECATED stub re-exporting @agentproto/provider-kit; 0 workspace dependents"],
  ["packages/workflow-ai-sdk", "dormant Vercel AI SDK projection of AIP-15 workflows; 0 workspace dependents"],
  ["packages/egress", "dormant egress-control prototype; 0 workspace dependents"],
  ["packages/identity", "dormant AIP-23 identity doctype, superseded by persona/role; 0 workspace dependents"],
  ["packages/lifecycle", "dormant AIP-37 lifecycle vocabulary prototype; 0 workspace dependents"],
  ["packages/catalog", "dormant agentcatalog/v1 catalog prototype; 0 workspace dependents"],
  ["packages/role-catalog", "dormant AIP-47 builtin role catalogue; 0 workspace dependents"],
  ["adapters/ai-sdk", "dormant Vercel AI SDK tool adapter; 0 workspace dependents"],
  ["adapters/mastra", "dormant generic Mastra tool adapter; 0 workspace dependents"],
])

/**
 * Core-infrastructure family the classification rule pins to `core` ahead of
 * the AIP-reference-implementation heuristic (some AIP packages are also the
 * runtime backbone).
 */
export const CORE_FAMILY = new Set([
  "packages/runtime",
  "packages/cli",
  "packages/driver/core",
  "packages/sandbox",
  "packages/auth",
  "packages/model-catalog",
])

/** Description/name keywords that mark a packages/* package as spec-only/doctype. */
export const SPEC_PATTERN = /(reference implementation|file-format|doctype|cross-vendor plugin format)/i

/** Parse the `packages:` glob list out of pnpm-workspace.yaml (minimal parser
 *  for this repo's shape: a top-level `packages:` key followed by `-"X"` list
 *  items). */
export function readWorkspaceGlobs(root = ROOT) {
  const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
  const globs = []
  let inPackages = false
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    const top = rawLine && !/^\s/.test(rawLine)
    if (top) inPackages = line === "packages:"
    if (!inPackages) continue
    const m = line.match(/^-\s*(["']?)(.+?)\1\s*$/)
    if (m) globs.push(m[2])
  }
  return globs
}

/**
 * Expand one glob pattern into workspace dirs (relative to `root`) that
 * contain a package.json. Supports the repo's two shapes:
 *   - `"dir/*"`  → each child dir of `dir` with a package.json
 *   - `"dir"`    → `dir` itself if it has a package.json
 * Star globs never recurse deeper (pnpm's `dir/*` doesn't match `dir/a/b`),
 * which automatically excludes sub-surface fixtures/templates (e.g.
 * `create-agentproto-app/templates/*`, `app-config/test-fixtures/*`).
 */
export function expandGlob(root, pattern) {
  const base = resolve(root, pattern.replace(/\/\*$/, ""))
  const out = []
  if (pattern.endsWith("/*")) {
    if (!existsSync(base)) return out
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === "node_modules") continue
      if (existsSync(join(base, e.name, "package.json"))) {
        out.push(relative(root, join(base, e.name)).replaceAll("\\", "/"))
      }
    }
  } else if (existsSync(join(base, "package.json"))) {
    out.push(relative(root, join(base, "")) || ".")
  }
  return out
}

/** Every workspace package dir (relative to root), sorted. */
export function collectWorkspaceDirs(root = ROOT) {
  const dirs = new Set()
  for (const g of readWorkspaceGlobs(root)) {
    for (const d of expandGlob(root, g)) dirs.add(d)
  }
  return [...dirs].sort((a, b) => a.localeCompare(b))
}

/** Workspace packages with metadata: { dir, name, version, description, pkg }. */
export function loadWorkspacePackages(root = ROOT) {
  return collectWorkspaceDirs(root).map((dir) => {
    const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"))
    return {
      dir,
      name: pkg.name || dir,
      version: pkg.version || "0.0.0",
      description: pkg.description || "",
      pkg,
    }
  })
}

/** Map package name -> { dir, label } dependents across all workspace
 *  package.json dependency fields (self-references excluded). */
export function dependencyIndex(packages, { root = ROOT } = {}) {
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
  const index = new Map() // dep name -> [{ dir, name, field }]
  for (const p of packages) {
    for (const field of fields) {
      for (const dep of Object.keys(p.pkg[field] ?? {})) {
        if (!index.has(dep)) index.set(dep, [])
        const list = index.get(dep)
        if (!list.some((d) => d.dir === p.dir)) list.push({ dir: p.dir, name: p.name, field })
      }
    }
  }
  for (const [dep, dependents] of index) {
    dependents.filter((d) => d.name !== dep)
    // list entries whose own name equals dep would be self-dep, impossible
  }
  return index
}

/**
 * Classify one package into exactly one tier.
 * @param {{
 *   dir: string, name: string, description: string,
 *   dependents: { name: string }[],
 *   archivedOverrides?: Set<string>, coreFamily?: Set<string>,
 * }} input
 * @returns {{ tier: string, reason: string, overrideKept?: boolean }}
 */
export function classify({
  dir,
  name,
  description,
  dependents,
  archivedOverrides = ARCHIVED_OVERRIDES,
  coreFamily = CORE_FAMILY,
}) {
  const natural = () => {
    if (dir.startsWith("adapters/")) {
      return { tier: "adapters", reason: "adapters/** binding for an external agent/CLI/browser/knowledge backend" }
    }
    if (coreFamily.has(dir)) {
      return { tier: "core", reason: "core family (runtime/cli/driver/sandbox/auth/model-catalog)" }
    }
    const spec = !dir.startsWith("adapters/") && SPEC_PATTERN.test(`${name} ${description}`)
    if (spec) {
      const keyword = (description.match(SPEC_PATTERN) || ["spec"])[0].toLowerCase()
      return { tier: "spec-reference", reason: `spec-only/doctype package (matches "${keyword}")` }
    }
    return { tier: "core", reason: "default: packages/* runtime/infra example or tooling package" }
  }
  if (archivedOverrides.has(dir)) {
    if (dependents.length === 0) {
      return { tier: "archived", reason: ARCHIVED_REASONS.get(dir) ?? "archived override: dormant (0 workspace dependents)" }
    }
    // Override exists but the package is not dead → natural tier, flagged.
    const n = natural()
    return { tier: n.tier, reason: n.reason, overrideKept: true }
  }
  return natural()
}

/** Build classification rows for the whole workspace. */
export function buildRows(root = ROOT, { packages } = {}) {
  const pkgs = packages ?? loadWorkspacePackages(root)
  const index = dependencyIndex(pkgs, { root })
  const rows = pkgs.map((p) => {
    const selfDependents = (index.get(p.name) ?? []).filter((d) => d.dir !== p.dir)
    const { tier, reason, overrideKept } = classify({
      dir: p.dir,
      name: p.name,
      description: p.description,
      dependents: selfDependents,
    })
    const note = p.version === "0.0.0" ? null : undefined
    return {
      name: p.name,
      path: p.dir,
      version: p.version,
      tier,
      reason: sanitizeReason(reason),
      overrideKept,
    }
  })

  // Fail loudly if any workspace package could be emitted twice.
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.path)) throw new Error(`duplicate workspace entry: ${r.path}`)
    if (seen.has(r.name)) throw new Error(`duplicate package name: ${r.name}`)
    seen.add(r.path)
  }
  return rows
}

/** Reason column is a markdown cell — strip pipes and newlines. */
export function sanitizeReason(reason = "") {
  return reason.replaceAll("|", "/").replace(/\s+/g, " ").trim()
}

const CLASSIFICATION_RULE = `\
## Classification rule

Every workspace package (the \`package.json\` files under the globs in
\`pnpm-workspace.yaml\`) lands in exactly one tier, decided in this order:

1. **archived** — explicitly dead packages (\`scripts/gen-status.mjs\`
   \`ARCHIVED_OVERRIDES\`). An override is only applied if the package really
   is dead, i.e. no other workspace package depends on its name; if it turns
   out not to be dead it keeps its natural tier instead.
2. **adapters** — package path under \`adapters/**\`: bindings for external
   agent/CLI/browser/knowledge backends.
3. **spec-reference** — \`packages/*\` spec-only/doctype packages: AIP
   reference implementations, open file-format standards, and meta-doctype
   helpers (AIP-54 REF, manifest verbs, etc.), detected from the package
   name/description.
4. **core** — the runtime/cli/driver/sandbox/auth/model-catalog family pinned
   by rule, plus every other \`packages/*\` package that is none of the above
   (default tier: runtime infra, binaries, UI shells, providers, tooling).

Rows are grouped by tier, sorted by path. One row per package — no package
appears twice. Regenerate with \`node scripts/gen-status.mjs\`; validate with
\`node scripts/gen-status.mjs --check\`.
`

export function renderStatus(rows, { workspaceCount = rows.length } = {}) {
  const lines = []
  lines.push("# STATUS.md — package tiers")
  lines.push("")
  lines.push(
    `A generated, read-only snapshot of every agentproto/ts workspace package (*${rows.length} packages), classified into four tiers.`,
  )
  lines.push("")
  lines.push(CLASSIFICATION_RULE.trimEnd())
  lines.push("")
  lines.push("## Tier counts")
  lines.push("")
  lines.push("| tier | count |")
  lines.push("| --- | --- |")
  for (const tier of TIERS) lines.push(`| \`${tier}\` | ${rows.filter((r) => r.tier === tier).length} |`)
  lines.push("")
  lines.push("## Packages")
  lines.push("")
  lines.push("| package | path | version | tier | reason |")
  lines.push("| --- | --- | --- | --- | --- |")
  for (const tier of TIERS) {
    for (const row of rows.filter((r) => r.tier === tier)) {
      lines.push(`| ${row.name} | ${row.path} | ${row.version} | ${row.tier} | ${row.reason} |`)
    }
  }
  return lines.join("\n") + "\n"
}

function main(argv) {
  if (argv.includes("--count")) {
    console.log(collectWorkspaceDirs().length)
    return 0
  }

  const packages = loadWorkspacePackages()
  const rows = buildRows(ROOT, { packages })
  const content = renderStatus(rows, { workspaceCount: packages.length })

  if (argv.includes("--check")) {
    const current = existsSync(STATUS_PATH) ? readFileSync(STATUS_PATH, "utf8") : ""
    if (current === content) {
      console.log("STATUS.md is up to date.")
      return 0
    }
    console.error("STATUS.md is out of date — run `node scripts/gen-status.mjs`.")
    return 1
  }

  writeFileSync(STATUS_PATH, content)
  console.log(`Wrote ${STATUS_PATH} (${rows.length} packages)`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2))
}
