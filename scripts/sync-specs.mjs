#!/usr/bin/env node
/**
 * sync-specs — vendor AgentProto JSON Schemas into `ts/specs/resources/`.
 *
 * The corpus conformance tests load schemas from `ts/specs/resources/`.
 * Schemas are authored upstream in a sibling spec source tree; this
 * script mirrors only the `*.schema.json` files into the package so the
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
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TS_ROOT = path.resolve(__dirname, "..")
const DEFAULT_SOURCE = path.resolve(TS_ROOT, "../agentproto/specs/resources")
const TARGET = path.resolve(TS_ROOT, "specs/resources")

const args = process.argv.slice(2)
let source = DEFAULT_SOURCE
let mode = "write" // "write" | "check" | "dry"
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--source") source = path.resolve(args[++i])
  else if (a === "--check") mode = "check"
  else if (a === "--dry-run") mode = "dry"
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

if (!existsSync(source)) {
  process.stderr.write(
    `sync-specs: source directory not found: ${source}\n` +
      `Run from a checkout that has the upstream spec tree available, ` +
      `or pass --source <dir>.\n`
  )
  process.exit(1)
}

/** Recursively collect every *.schema.json file relative to `root`. */
function collectSchemas(root) {
  const out = []
  const walk = dir => {
    for (const ent of readdirSync(dir)) {
      const full = path.join(dir, ent)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile() && ent.endsWith(".schema.json")) {
        out.push(path.relative(root, full))
      }
    }
  }
  walk(root)
  return out.sort()
}

const sourceFiles = collectSchemas(source)
const targetFiles = existsSync(TARGET) ? collectSchemas(TARGET) : []

// Detect drift = source/target file sets or byte contents differ.
const toCopy = []
const toRemove = []

const sourceSet = new Set(sourceFiles)
const targetSet = new Set(targetFiles)

for (const rel of sourceFiles) {
  const srcPath = path.join(source, rel)
  const dstPath = path.join(TARGET, rel)
  if (!existsSync(dstPath)) {
    toCopy.push(rel)
    continue
  }
  const srcBytes = readFileSync(srcPath)
  const dstBytes = readFileSync(dstPath)
  if (!srcBytes.equals(dstBytes)) toCopy.push(rel)
}
for (const rel of targetFiles) {
  if (!sourceSet.has(rel)) toRemove.push(rel)
}

const drift = toCopy.length > 0 || toRemove.length > 0

if (mode === "check") {
  if (drift) {
    process.stderr.write(
      `sync-specs --check: vendored schemas drift from ${source}\n` +
        (toCopy.length ? `  changed/added (${toCopy.length}): ${toCopy.slice(0, 5).join(", ")}${toCopy.length > 5 ? ", …" : ""}\n` : "") +
        (toRemove.length ? `  stale (${toRemove.length}): ${toRemove.slice(0, 5).join(", ")}${toRemove.length > 5 ? ", …" : ""}\n` : "") +
        `Re-run scripts/sync-specs.mjs (no --check) to refresh.\n`
    )
    process.exit(1)
  }
  process.stdout.write(`sync-specs: ${sourceFiles.length} schemas in sync.\n`)
  process.exit(0)
}

if (!drift) {
  process.stdout.write(`sync-specs: ${sourceFiles.length} schemas already in sync.\n`)
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
  writeFileSync(dstPath, readFileSync(srcPath))
}
for (const rel of toRemove) {
  rmSync(path.join(TARGET, rel), { force: true })
}

process.stdout.write(
  `sync-specs: wrote ${toCopy.length} schema${toCopy.length === 1 ? "" : "s"}, ` +
    `removed ${toRemove.length} stale.\n`
)
