#!/usr/bin/env node
/**
 * Check the TypeScript reference implementation against the canonical AIP
 * names in `specs/names.json` (AIP-70 GLOSSARY, Naming rules).
 *
 * The specs repository owns the registry; this script reads a copy of it and
 * compares what the packages under `packages/` and `adapters/` claim:
 *
 *   ts:aip-<n>:package      the entry's `package` does not exist
 *   ts:aip-<n>:spec-name    the package's `SPEC_NAME`/`SPEC_ID` constant
 *                           differs from the entry's `specId`
 *   ts:aip-<n>:define       the package has no `export` of the entry's
 *                           `define` function in its non-test `src` TypeScript
 *   ts:package:<name>:unregistered
 *                           the package's `SPEC_NAME` claims an `agent<x>/v<N>`
 *                           or `<x>/v<N>` name but no registry entry names the
 *                           package (the name belongs to another package or
 *                           to none)
 *
 * Superseded entries are exempt, as in the spec-side check.
 *
 * The check is a ratchet. `scripts/names-pending.json`
 * (`{ "pending": ["..."] }`) lists the deviations known today. A deviation
 * not pending FAILS (new drift), and a pending id that no longer deviates
 * FAILS too (it was fixed: remove it, so it cannot come back).
 * `--write-pending` rewrites the file; use it only to bootstrap or after a
 * reviewed batch of renames.
 *
 * A missing `--names` file is not a failure: the pinned canonical commit
 * predates AIP-70, so there is nothing to compare against yet.
 *
 * House style follows scripts/check-aip-refs.mjs: plain Node ESM, no deps,
 * counted summary, exit 1 on failure with `file:line` for each.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".turbo", "coverage"])
const TEST_FILE_RE = /\.(test|spec)\.ts$/
const SPEC_CONST_RE = /^\s*(?:export\s+)?const\s+(SPEC_NAME|SPEC_ID)\b[^=\n]*=\s*["']([^"']+)["']/
const SPEC_NAME_FORM_RE = /^(?:agent)?[a-z][a-z0-9-]*\/v\d+$/

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue
    const key = argv[i].slice(2)
    if (key === "write-pending") args.writePending = true
    else args[key] = argv[i + 1]
  }
  return args
}

function* walk(dir, { stopAtPackage = false } = {}) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (stopAtPackage && existsSync(path.join(full, "package.json"))) continue
      yield* walk(full, { stopAtPackage })
    } else {
      yield full
    }
  }
}

function isTestFile(file) {
  return TEST_FILE_RE.test(file) || file.split(path.sep).some((s) => s === "__tests__" || s === "__snapshots__")
}

function sourceFiles(pkg) {
  const src = path.join(pkg.dir, "src")
  const out = []
  for (const file of walk(src)) {
    if (file.endsWith(".ts") && !isTestFile(file)) out.push(file)
  }
  return out
}

/** `[{ name, dir, files }]` for every package.json under packages/ and
 *  adapters/, at any depth. Descent stops at a dir that has its own
 *  package.json: anything below it is that package's content. */
function indexPackages(root) {
  const packages = []
  const visit = (dir) => {
    const pj = path.join(dir, "package.json")
    if (existsSync(pj)) {
      let pkg
      try {
        pkg = JSON.parse(readFileSync(pj, "utf8"))
      } catch {
        return
      }
      if (!pkg.name) return
      const files = sourceFiles({ dir })
      const constants = []
      for (const file of files) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const m = SPEC_CONST_RE.exec(line)
            if (m) constants.push({ kind: m[1], value: m[2], file, line: i + 1 })
          })
      }
      packages.push({ name: pkg.name, dir, files, constants })
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue
      visit(path.join(dir, entry.name))
    }
  }
  for (const group of ["packages", "adapters"]) {
    const abs = path.join(root, group)
    if (existsSync(abs)) visit(abs)
  }
  return packages
}

function hasDefine(pkg, define) {
  const name = define.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const functionRe = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${name}\\b`)
  const constRe = new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${name}\\b`)
  const listRe = new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, "s")
  for (const file of pkg.files) {
    const text = readFileSync(file, "utf8")
    if (functionRe.test(text) || constRe.test(text) || listRe.test(text)) return true
  }
  return false
}

export function checkNames({ root = ROOT, namesPath, writePending = false } = {}) {
  const names = namesPath ?? path.join(root, "specs", "names.json")
  if (!existsSync(names)) {
    return { skipped: true, deviations: new Map(), fresh: [], fixed: [], pending: [], packageCount: 0 }
  }

  const registry = JSON.parse(readFileSync(names, "utf8"))
  const packages = indexPackages(root)
  const byName = new Map(packages.map((p) => [p.name, p]))
  const deviations = new Map()
  const deviate = (id, where, message) => {
    if (!deviations.has(id)) deviations.set(id, { where, message })
  }

  const registeredPackages = new Set()
  for (const entry of registry.aips ?? []) {
    if (entry.package) registeredPackages.add(entry.package)
    if (entry.supersededBy || !entry.package) continue
    const n = entry.aip
    const pkg = byName.get(entry.package)
    if (!pkg) {
      deviate(`ts:aip-${n}:package`, null, `no package named "${entry.package}"`)
      continue
    }
    if (entry.specId) {
      const wrong = pkg.constants.find((c) => c.value !== entry.specId)
      if (wrong) {
        deviate(
          `ts:aip-${n}:spec-name`,
          `${path.relative(root, wrong.file)}:${wrong.line}`,
          `${wrong.kind} is "${wrong.value}", registry specId is "${entry.specId}" in ${entry.package}`,
        )
      }
    }
    if (entry.define && !hasDefine(pkg, entry.define)) {
      deviate(
        `ts:aip-${n}:define`,
        null,
        `${entry.package} has no exported "${entry.define}" in src/**/*.ts`,
      )
    }
  }

  for (const pkg of packages) {
    if (registeredPackages.has(pkg.name)) continue
    const claiming = pkg.constants.find((c) => c.value !== undefined && SPEC_NAME_FORM_RE.test(c.value))
    if (!claiming) continue
    deviate(
      `ts:package:${pkg.name}:unregistered`,
      `${path.relative(root, claiming.file)}:${claiming.line}`,
      `${pkg.name} claims "${claiming.value}" but no registry entry names that package`,
    )
  }

  const pendingPath = path.join(root, "scripts", "names-pending.json")
  let pending = []
  if (existsSync(pendingPath)) {
    try {
      pending = JSON.parse(readFileSync(pendingPath, "utf8")).pending ?? []
    } catch {
      pending = []
    }
  }

  if (writePending) {
    const ids = [...deviations.keys()].sort()
    mkdirSync(path.dirname(pendingPath), { recursive: true })
    writeFileSync(pendingPath, `${JSON.stringify({ pending: ids }, null, 2)}\n`)
    return { skipped: false, deviations, fresh: [], fixed: [], pending: ids, wrote: true, pendingPath, packageCount: packages.length }
  }

  const pendingSet = new Set(pending)
  const fresh = [...deviations.keys()].filter((id) => !pendingSet.has(id)).sort()
  const fixed = [...pending].filter((id) => !deviations.has(id)).sort()
  return { skipped: false, deviations, fresh, fixed, pending, pendingPath, packageCount: packages.length }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.root ? path.resolve(args.root) : ROOT
  const namesPath = args.names ? path.resolve(args.names) : path.join(root, "specs", "names.json")
  const result = checkNames({ root, namesPath, writePending: Boolean(args.writePending) })

  if (result.skipped) {
    console.log(`check-names: skipped, ${path.relative(process.cwd(), namesPath) || namesPath} does not exist (canonical pin predates AIP-70)`)
    process.exit(0)
  }

  const { deviations, fresh, fixed, pending } = result
  const total = deviations.size
  const summary = `checked ${result.packageCount} package(s): ${total} deviations (${pending.length} pending, ${fresh.length} new, ${fixed.length} fixed)`

  if (result.wrote) {
    console.log(`wrote ${pending.length} pending deviations to ${path.relative(process.cwd(), result.pendingPath) || result.pendingPath}`)
    console.log(summary)
    process.exit(0)
  }

  const failures = []
  for (const id of fresh) {
    const d = deviations.get(id)
    failures.push(d.where ? `${d.where}: ${d.message} [${id}] (new deviation)` : `${id}: ${d.message}`)
  }
  for (const id of fixed) {
    failures.push(`${path.relative(process.cwd(), result.pendingPath) || result.pendingPath}: pending "${id}" no longer deviates; remove it`)
  }

  if (failures.length) {
    for (const line of failures) console.error(line)
    console.log(summary)
    process.exit(1)
  }
  console.log(summary)
  process.exit(0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
