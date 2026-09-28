#!/usr/bin/env node
/**
 * sync-specs — vendor AgentProto JSON Schemas (+ conformance vectors) into
 * `ts/specs/resources/`.
 *
 * The corpus conformance tests load schemas from `ts/specs/resources/`.
 * Schemas are authored upstream in a sibling spec source tree; this
 * script mirrors the `*.schema.json` files, plus any `vectors/` directory's
 * `*.json` fixtures (and the `README.md` describing them) into the package so the
 * `ts/` repo is self-contained (CI / OSS contributors don't need the
 * upstream tree on disk).
 *
 * Usage:
 *   node scripts/sync-specs.mjs                 # default source: ../agentproto/specs/resources
 *   node scripts/sync-specs.mjs --source <dir>  # custom source root
 *   node scripts/sync-specs.mjs --check         # exit 1 if vendored tree drifts from source
 *   node scripts/sync-specs.mjs --dry-run       # report planned changes, no writes
 *
 * The target (`ts/specs/resources/`) is fully replaced — files removed
 * upstream are removed here too, so the vendored copy never drifts.
 *
 * Known, pending-spec drift — fields ts ships ahead of what canonical has
 * ratified — is recorded in `specs/spec-drift-allowlist.json` (file + dot
 * path + reason). Both `--check` and a plain sync are allowlist-aware:
 *   - `--check` masks exactly those fields before diffing against
 *     canonical, so the gate is green for KNOWN drift and fails on
 *     anything new. It separately asserts every allowlisted field is
 *     still present (and, when canonical has the same path, still
 *     different from canonical) in the vendored copy, so a resync can't
 *     silently drop one (the class of incident PR #1235 caught for
 *     generated code — this is the same discipline for the vendored
 *     JSON itself).
 *   - A plain sync grafts each allowlisted field's current vendored value
 *     onto the freshly-copied upstream content instead of overwriting it,
 *     so re-running this script never reverts a known, deliberate drift.
 *
 * CI has no network and no sibling `agentproto/agentproto` checkout (no
 * such mechanism exists in this repo today — see the spec-drift-gate PR
 * body). Without `--source`, `--check` degrades to the network-free half
 * of the gate: the allowlist presence/difference assertions above, which
 * need only the vendored copy and the allowlist file. The full
 * vendored-vs-canonical diff runs for any contributor with a real sibling
 * checkout (the DEFAULT_SOURCE convention below), or when `--source` is
 * passed explicitly.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TS_ROOT = path.resolve(__dirname, "..")
const DEFAULT_SOURCE = path.resolve(TS_ROOT, "../agentproto/specs/resources")
let TARGET = path.resolve(TS_ROOT, "specs/resources")
let ALLOWLIST_PATH = path.resolve(TS_ROOT, "specs/spec-drift-allowlist.json")

const args = process.argv.slice(2)
let source = DEFAULT_SOURCE
let sourceExplicit = false
let mode = "write" // "write" | "check" | "dry"
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--source") {
    source = path.resolve(args[++i])
    sourceExplicit = true
  } else if (a === "--check") mode = "check"
  else if (a === "--dry-run") mode = "dry"
  // Internal, undocumented overrides — used by scripts/sync-specs.test.mjs
  // to exercise the allowlist logic against isolated fixtures instead of
  // this repo's real specs/resources tree.
  else if (a === "--target") TARGET = path.resolve(args[++i])
  else if (a === "--allowlist") ALLOWLIST_PATH = path.resolve(args[++i])
  else if (a === "--help" || a === "-h") {
    process.stdout.write(
      "Usage: sync-specs.mjs [--source <dir>] [--check | --dry-run]\n"
    )
    process.exit(0)
  } else {
    process.stderr.write(`sync-specs: unknown argument ${a}\n`)
    process.exit(2)
  }
}

// ── Allowlist ─────────────────────────────────────────────────────────

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return { entries: [] }
  const doc = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"))
  if (!Array.isArray(doc.entries)) {
    throw new Error(`sync-specs: ${ALLOWLIST_PATH} malformed — expected { entries: [...] }`)
  }
  return doc
}

function entriesForFile(allowlist, rel) {
  return allowlist.entries.filter(e => e.file === rel)
}

function getAtPath(obj, dotPath) {
  const parts = dotPath.split(".")
  let cur = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== "object" || !(p in cur)) return { found: false }
    cur = cur[p]
  }
  return { found: true, value: cur }
}

function setAtPath(obj, dotPath, value) {
  const parts = dotPath.split(".")
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
}

function deleteAtPath(obj, dotPath) {
  const parts = dotPath.split(".")
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return
    cur = cur[parts[i]]
  }
  if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]]
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return a === b
  if (typeof a !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  return (
    ak.length === bk.length &&
    ak.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  )
}

/**
 * Network-free half of the gate: every allowlisted field must still be
 * present in the vendored copy. When `canonicalRoot` is supplied (a real
 * upstream checkout was found), also assert the field still differs from
 * canonical where canonical has the same path at all — a field that has
 * quietly become identical to canonical is either stale (ratified, entry
 * should be removed) or was itself silently overwritten; either way it's
 * worth failing loudly rather than staying silently green.
 */
function checkAllowlistIntegrity(allowlist, canonicalRoot) {
  const problems = []
  const byFile = new Map()
  for (const e of allowlist.entries) {
    if (!byFile.has(e.file)) byFile.set(e.file, [])
    byFile.get(e.file).push(e)
  }
  for (const [rel, entries] of byFile) {
    const targetPath = path.join(TARGET, rel)
    if (!existsSync(targetPath)) {
      problems.push(`${rel}: allowlisted but the vendored file no longer exists`)
      continue
    }
    const target = JSON.parse(readFileSync(targetPath, "utf8"))
    let canonical
    if (canonicalRoot) {
      const canonicalPath = path.join(canonicalRoot, rel)
      canonical = existsSync(canonicalPath) ? JSON.parse(readFileSync(canonicalPath, "utf8")) : undefined
    }
    for (const e of entries) {
      const t = getAtPath(target, e.field)
      if (!t.found) {
        problems.push(`${rel}: "${e.field}" is missing from the vendored copy — was it silently reverted by a sync? (${e.reason})`)
        continue
      }
      if (canonical) {
        const c = getAtPath(canonical, e.field)
        if (c.found && deepEqual(t.value, c.value)) {
          problems.push(`${rel}: "${e.field}" now matches canonical — either ratified upstream (remove this allowlist entry) or silently overwritten (${e.reason})`)
        }
      }
    }
  }
  if (problems.length > 0) {
    return { ok: false, message: `sync-specs: allowlist integrity failed:\n${problems.map(p => `  - ${p}`).join("\n")}\n` }
  }
  return { ok: true, message: `sync-specs: ${allowlist.entries.length} allowlisted known-drift field(s) present and intact.\n` }
}

/** Deep-clone `target`, then for each allowlisted field either copy
 *  canonical's value at that path (a real spec change ts hasn't diverged
 *  on) or delete it (a pure ts-ahead addition canonical doesn't have) —
 *  neutralizing exactly the known drift so what remains is comparable. */
function maskKnownDrift(target, canonical, fields) {
  const masked = JSON.parse(JSON.stringify(target))
  for (const field of fields) {
    const c = getAtPath(canonical, field)
    if (c.found) setAtPath(masked, field, c.value)
    else deleteAtPath(masked, field)
  }
  return masked
}

/** Deep-clone freshly-copied `source` content, then graft each
 *  allowlisted field's CURRENT vendored value back onto it — so a plain
 *  sync brings in real upstream changes without reverting known drift. */
function graftKnownDrift(source, oldTarget, fields) {
  const grafted = JSON.parse(JSON.stringify(source))
  for (const field of fields) {
    const old = getAtPath(oldTarget, field)
    if (old.found) setAtPath(grafted, field, old.value)
  }
  return grafted
}

const allowlist = loadAllowlist()

if (!existsSync(source)) {
  if (mode === "check" && !sourceExplicit) {
    process.stdout.write(
      `sync-specs --check: no upstream checkout at ${source}. That's expected in CI ` +
        `(no network, no sibling agentproto/agentproto checkout — see the sync-specs.mjs ` +
        `header) and for any contributor without one. Skipping the vendored-vs-canonical ` +
        `diff; running the network-free half of the gate instead.\n`
    )
    const result = checkAllowlistIntegrity(allowlist, undefined)
    process.stdout.write(result.ok ? result.message : "")
    if (!result.ok) {
      process.stderr.write(result.message)
      process.exit(1)
    }
    process.exit(0)
  }
  process.stderr.write(
    `sync-specs: source directory not found: ${source}\n` +
      `Run from a checkout that has the upstream spec tree available, ` +
      `or pass --source <dir>.\n`
  )
  process.exit(1)
}

/** A `*.schema.json` file anywhere, or a `vectors/`-directory's `*.json`
 *  fixtures and its `README.md` — the two file shapes this script vendors. */
function isVendoredFile(dir, name) {
  if (name.endsWith(".schema.json")) return true
  if (path.basename(dir) === "vectors") {
    return name.endsWith(".json") || name === "README.md"
  }
  return false
}

/** Recursively collect every vendored file (see {@link isVendoredFile}) relative to `root`. */
function collectVendoredFiles(root) {
  const out = []
  const walk = dir => {
    for (const ent of readdirSync(dir)) {
      const full = path.join(dir, ent)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile() && isVendoredFile(dir, ent)) {
        out.push(path.relative(root, full))
      }
    }
  }
  walk(root)
  return out.sort()
}

const sourceFiles = collectVendoredFiles(source)
const targetFiles = existsSync(TARGET) ? collectVendoredFiles(TARGET) : []
const sourceSet = new Set(sourceFiles)

// Detect drift = source/target file sets or (allowlist-masked) contents differ.
const toCopy = []
const toRemove = []
/** rel -> grafted object to write instead of a raw byte copy, when the
 *  file has allowlist entries and needs a real update (write mode only). */
const grafts = new Map()

for (const rel of sourceFiles) {
  const srcPath = path.join(source, rel)
  const dstPath = path.join(TARGET, rel)
  const fields = entriesForFile(allowlist, rel).map(e => e.field)

  if (!existsSync(dstPath)) {
    toCopy.push(rel)
    continue
  }

  const srcBytes = readFileSync(srcPath)
  const dstBytes = readFileSync(dstPath)
  if (srcBytes.equals(dstBytes)) continue

  if (fields.length === 0) {
    toCopy.push(rel)
    continue
  }

  // Allowlisted file: only real drift (beyond the known fields) counts.
  const srcJson = JSON.parse(srcBytes.toString("utf8"))
  const dstJson = JSON.parse(dstBytes.toString("utf8"))
  const masked = maskKnownDrift(dstJson, srcJson, fields)
  if (!deepEqual(masked, srcJson)) {
    toCopy.push(rel)
    grafts.set(rel, graftKnownDrift(srcJson, dstJson, fields))
  }
}
for (const rel of targetFiles) {
  if (!sourceSet.has(rel)) toRemove.push(rel)
}

const drift = toCopy.length > 0 || toRemove.length > 0

if (mode === "check") {
  const integrity = checkAllowlistIntegrity(allowlist, source)
  if (drift || !integrity.ok) {
    process.stderr.write(
      `sync-specs --check: vendored files drift from ${source}\n` +
        (toCopy.length ? `  changed/added (${toCopy.length}): ${toCopy.slice(0, 5).join(", ")}${toCopy.length > 5 ? ", …" : ""}\n` : "") +
        (toRemove.length ? `  stale (${toRemove.length}): ${toRemove.slice(0, 5).join(", ")}${toRemove.length > 5 ? ", …" : ""}\n` : "") +
        (!integrity.ok ? integrity.message : "") +
        `Re-run scripts/sync-specs.mjs (no --check) to refresh.\n`
    )
    process.exit(1)
  }
  process.stdout.write(`sync-specs: ${sourceFiles.length} files in sync (${allowlist.entries.length} known-drift fields masked). ${integrity.message}`)
  process.exit(0)
}

if (!drift) {
  process.stdout.write(`sync-specs: ${sourceFiles.length} files already in sync.\n`)
  process.exit(0)
}

if (mode === "dry") {
  process.stdout.write(
    `sync-specs (dry-run): ${toCopy.length} to copy, ${toRemove.length} to remove\n`
  )
  for (const rel of toCopy) process.stdout.write(`  + ${rel}\n`)
  for (const rel of toRemove) process.stdout.write(`  - ${rel}\n`)
  process.exit(0)
}

for (const rel of toCopy) {
  const srcPath = path.join(source, rel)
  const dstPath = path.join(TARGET, rel)
  mkdirSync(path.dirname(dstPath), { recursive: true })
  if (grafts.has(rel)) {
    writeFileSync(dstPath, `${JSON.stringify(grafts.get(rel), null, 2)}\n`)
  } else {
    writeFileSync(dstPath, readFileSync(srcPath))
  }
}
for (const rel of toRemove) {
  rmSync(path.join(TARGET, rel), { force: true })
}

process.stdout.write(
  `sync-specs: wrote ${toCopy.length} file${toCopy.length === 1 ? "" : "s"}, ` +
    `removed ${toRemove.length} stale.\n`
)
