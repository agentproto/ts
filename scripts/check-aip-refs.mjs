#!/usr/bin/env node
/**
 * check-aip-refs — catch dangling `AIP-<N>` references and stale "no AIP"
 * claims against the canonical AIP registry.
 *
 * Why this exists: `specs/resources/` (see scripts/sync-specs.mjs) only
 * vendors JSON Schemas for scaffolded doctypes — "Spec text is authored in
 * agentproto/agentproto, never here" by design. That's correct for codegen,
 * but it means nothing in this repo tells anyone when a *prose-only* AIP
 * ships upstream. AIP-65 (DECISION.md) merged into agentproto/agentproto on
 * 2026-10-11 with no scaffolded schema, so `sync-specs.mjs --check` had
 * nothing to flag, and `packages/runtime/src/decision-policy.ts` kept
 * claiming "there is no AIP for decision policies yet" after it was wrong —
 * exactly the drift this script is meant to catch going forward.
 *
 * It reads the canonical AIP registry from `specs/meta.json`'s `pages` list
 * (slugs + nav order only — still never the prose body) in the same
 * canonical checkout CI already stages for the schema-drift check
 * (`.canonical-specs`, pinned at `specs/canonical.lock.json`), then:
 *
 *   1. FAILS on any `AIP-<N>` reference in source whose N isn't a known
 *      canonical AIP (a typo, or a number nobody ever assigned);
 *   2. WARNS (non-fatal — language heuristics, not ground truth) on any
 *      "no AIP ..." / "AIP ... yet" phrase, so a human re-checks it against
 *      the registry on every run instead of only when someone happens to
 *      remember.
 *
 * Usage:
 *   node scripts/check-aip-refs.mjs --source <agentproto checkout root>
 */

import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const DEFAULT_SOURCE = path.resolve(ROOT, "../agentproto")

const DEFAULT_SCAN_DIRS = ["packages", "adapters", "apps", "scripts", "docs"]
const SCAN_EXT = new Set([".ts", ".tsx", ".mjs", ".md", ".mdx"])
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".turbo", "coverage", "__tests__"])
// This script's own doc comments/fixtures talk *about* "AIP-N" and "no AIP"
// as strings, and test fixtures use placeholder numbers (e.g. AIP-999) on
// purpose — neither is a real claim to verify against the registry.
const SKIP_FILE_NAMES = new Set(["check-aip-refs.mjs", "check-aip-refs.test.mjs"])
const TEST_FILE_RE = /\.test\.(ts|tsx|mjs)$/

const AIP_REF_RE = /\bAIP-(\d+)\b/g
const NO_AIP_RE = /\bno AIP\b|\bnot yet\b[^.\n]{0,30}\bAIP\b|\bAIP\b[^.\n]{0,20}\byet\b/i

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

export function loadCanonicalAipNumbers(sourceRoot) {
  const metaPath = path.join(sourceRoot, "specs", "meta.json")
  const meta = JSON.parse(readFileSync(metaPath, "utf8"))
  const numbers = new Set()
  for (const slug of meta.pages ?? []) {
    const m = /^aip-(\d+)$/.exec(slug)
    if (m) numbers.add(Number(m[1]))
  }
  if (numbers.size === 0) throw new Error(`no AIP pages found in ${metaPath}`)
  return numbers
}

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (SCAN_EXT.has(path.extname(entry.name)) && !SKIP_FILE_NAMES.has(entry.name) && !TEST_FILE_RE.test(entry.name))
      yield full
  }
}

export function checkAipRefs({ sourceRoot = DEFAULT_SOURCE, scanRoot = ROOT, scanDirs = DEFAULT_SCAN_DIRS } = {}) {
  const known = loadCanonicalAipNumbers(sourceRoot)
  const unresolved = []
  const warnings = []

  for (const dir of scanDirs) {
    for (const file of walk(path.join(scanRoot, dir))) {
      const rel = path.relative(scanRoot, file)
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        for (const m of line.matchAll(AIP_REF_RE)) {
          const n = Number(m[1])
          if (!known.has(n)) {
            unresolved.push(`${rel}:${i + 1}: AIP-${n} does not resolve against the canonical registry`)
          }
        }
        if (NO_AIP_RE.test(line)) warnings.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
  }

  return { ok: unresolved.length === 0, unresolved, warnings }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const sourceRoot = args.source ? path.resolve(args.source) : DEFAULT_SOURCE
  const { ok, unresolved, warnings } = checkAipRefs({ sourceRoot })

  if (warnings.length > 0) {
    console.log(`check-aip-refs: ${warnings.length} "no AIP" phrase(s) to re-verify against the canonical registry:`)
    for (const w of warnings) console.log(`  ${w}`)
  }
  if (!ok) {
    console.error(`check-aip-refs: ${unresolved.length} dangling AIP-N reference(s):`)
    for (const u of unresolved) console.error(`  ${u}`)
  } else {
    console.log("check-aip-refs: all AIP-N references resolve.")
  }
  process.exit(ok ? 0 : 1)
}
