#!/usr/bin/env node
/**
 * Rewrite drifted adapter npm pins from the output of
 * `scripts/check-adapter-pins.mjs --json`.
 *
 * Policy (deterministic, no network, no model):
 *   - minor / patch drift is bumped, major drift is only reported;
 *   - a pin is bumped only where it is an explicit spawn pin, that is a
 *     `<package>@<version>` string in the adapter directory (bin_args, install
 *     package, docs, tests) plus an exact `range: "=<version>"` that guards it.
 *     An adapter whose only "pin" is a `version_check.range` floor (or a
 *     package.json dependency) has no spawn pin to rewrite: bumping the floor
 *     would change nothing at runtime, so the smoke test could prove nothing.
 *     Those are reported as `floor-only`, never edited.
 *
 * Usage:
 *   node scripts/bump-adapter-pins.mjs --report <check.json>
 *     [--adapters-dir <dir>] [--plan-out <file>] [--body-out <file>] [--dry-run]
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ADAPTERS_DIR = resolve(HERE, "..", "adapters")
const BUMPABLE = new Set(["minor", "patch"])
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "__fixtures__"])
const SKIP_FILES = new Set(["CHANGELOG.md", "package.json"])
const TEXT_EXT = /\.(ts|tsx|mjs|md)$/

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Split check-adapter-pins rows into rows to try, majors held back, and noise. */
export function classifyRows(rows) {
  const candidates = []
  const heldMajor = []
  for (const row of rows) {
    if (BUMPABLE.has(row.drift)) candidates.push(row)
    else if (row.drift === "major") heldMajor.push(row)
  }
  return { candidates, heldMajor }
}

function listFiles(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...listFiles(full))
    else if (TEXT_EXT.test(name) && !SKIP_FILES.has(name)) out.push(full)
  }
  return out
}

/** Pure text rewrite: `pkg@from` -> `pkg@to`, and an exact `range: "=from"` guard. */
export function rewriteText(text, pkg, from, to) {
  const spec = new RegExp(`${escapeRegExp(pkg)}@${escapeRegExp(from)}(?![\\w-]|\\.\\d)`, "g")
  let count = 0
  let next = text.replace(spec, () => {
    count++
    return `${pkg}@${to}`
  })
  if (count === 0) return { text, count: 0 }
  const range = new RegExp(`(range:\\s*["'])=${escapeRegExp(from)}(["'])`, "g")
  next = next.replace(range, `$1=${to}$2`)
  return { text: next, count }
}

/**
 * Apply the bumps under `adaptersDir`. Returns what changed and what was
 * skipped (with a reason), without ever throwing on a missing adapter.
 */
export function applyBumps(rows, adaptersDir = DEFAULT_ADAPTERS_DIR, { dryRun = false } = {}) {
  const { candidates, heldMajor } = classifyRows(rows)
  const bumped = []
  const floorOnly = []
  for (const row of candidates) {
    const dir = join(adaptersDir, row.adapter)
    let files
    try {
      files = listFiles(dir)
    } catch {
      floorOnly.push({ ...row, reason: "adapter directory not found" })
      continue
    }
    const changedFiles = []
    for (const file of files) {
      const before = readFileSync(file, "utf8")
      const { text, count } = rewriteText(before, row.package, row.pinned, row.latest)
      if (count === 0) continue
      if (!dryRun) writeFileSync(file, text)
      changedFiles.push(file)
    }
    if (changedFiles.length === 0) {
      floorOnly.push({
        ...row,
        reason: "no explicit spawn pin (version_check range floor or dependency only)",
      })
    } else {
      bumped.push({
        adapter: row.adapter,
        package: row.package,
        from: row.pinned,
        to: row.latest,
        drift: row.drift,
        files: changedFiles.map((file) => file.slice(adaptersDir.length + 1)),
      })
    }
  }
  return {
    bumped,
    floorOnly,
    heldMajor: heldMajor.map((row) => ({
      adapter: row.adapter,
      package: row.package,
      from: row.pinned,
      to: row.latest,
    })),
  }
}

export function renderBody(plan, { runUrl = null } = {}) {
  const lines = []
  lines.push("Automated adapter pin update from the weekly `Adapter pin freshness` workflow.")
  lines.push("")
  lines.push("Only minor and patch drift is bumped here. Merging is a human decision: the")
  lines.push("`Adapter pin smoke` check on this PR is the proof that each bumped harness still")
  lines.push("completes one real turn, and its job summary says which adapters were really")
  lines.push("exercised and which were skipped for lack of a credential.")
  lines.push("")
  lines.push("### Bumped")
  lines.push("")
  if (plan.bumped.length === 0) {
    lines.push("_none_")
  } else {
    lines.push("| adapter | package | from | to | drift |")
    lines.push("|---|---|---|---|---|")
    for (const item of plan.bumped) {
      lines.push(`| ${item.adapter} | \`${item.package}\` | ${item.from} | ${item.to} | ${item.drift} |`)
    }
  }
  if (plan.heldMajor.length > 0) {
    lines.push("")
    lines.push("### Major drift, NOT bumped (needs a human migration)")
    lines.push("")
    lines.push("| adapter | package | pinned | latest |")
    lines.push("|---|---|---|---|")
    for (const item of plan.heldMajor) {
      lines.push(`| ${item.adapter} | \`${item.package}\` | ${item.from} | ${item.to} |`)
    }
  }
  if (plan.floorOnly.length > 0) {
    lines.push("")
    lines.push("### Drifted but not bumped (no explicit spawn pin)")
    lines.push("")
    lines.push("| adapter | package | floor | latest | why |")
    lines.push("|---|---|---|---|---|")
    for (const item of plan.floorOnly) {
      lines.push(`| ${item.adapter} | \`${item.package}\` | ${item.pinned} | ${item.latest} | ${item.reason} |`)
    }
  }
  lines.push("")
  lines.push("### Credentials the smoke job can use")
  lines.push("")
  lines.push("Repo secrets read by `Adapter pin smoke`: `ANTHROPIC_API_KEY` (claude-code, mastracode),")
  lines.push("`OPENAI_API_KEY` (codex), `GEMINI_API_KEY` (gemini). opencode needs none: it runs on a")
  lines.push("zero-priced model discovered at run time. An adapter without its secret is reported")
  lines.push("as `skipped: no credential` in the job summary, which is NOT a pass.")
  if (runUrl) {
    lines.push("")
    lines.push(`Generated by ${runUrl}`)
  }
  lines.push("")
  return lines.join("\n")
}

function parseArgs(argv) {
  const out = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") out.dryRun = true
    else if (arg === "--report") out.report = argv[++i]
    else if (arg === "--adapters-dir") out.adaptersDir = argv[++i]
    else if (arg === "--plan-out") out.planOut = argv[++i]
    else if (arg === "--body-out") out.bodyOut = argv[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.report) throw new Error("--report <check-adapter-pins.json> is required")
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const report = JSON.parse(readFileSync(args.report, "utf8"))
  const plan = applyBumps(report.rows ?? [], args.adaptersDir ?? DEFAULT_ADAPTERS_DIR, {
    dryRun: args.dryRun,
  })
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null
  if (args.planOut) writeFileSync(args.planOut, `${JSON.stringify(plan, null, 2)}\n`)
  if (args.bodyOut) writeFileSync(args.bodyOut, renderBody(plan, { runUrl }))
  process.stdout.write(
    `bumped=${plan.bumped.length} heldMajor=${plan.heldMajor.length} floorOnly=${plan.floorOnly.length}\n`,
  )
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
