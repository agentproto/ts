#!/usr/bin/env node
/**
 * List every npm package pin declared by the harness adapters and compare it
 * with the latest stable version on the npm registry.
 *
 * A pin is an explicit version on `install[].package` or the npx target in
 * `bin_args`; adapters that only declare a `version_check.range` use that
 * range's lower bound as the pinned version.
 *
 * Usage:
 *   node scripts/check-adapter-pins.mjs
 *   node scripts/check-adapter-pins.mjs --json
 *   node scripts/check-adapter-pins.mjs --strict
 */

import { execFile } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")
const DEFAULT_ADAPTERS_DIR = join(ROOT, "adapters")

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function splitPackageSpec(spec) {
  const at = spec.lastIndexOf("@")
  if (at > 0) {
    const version = spec.slice(at + 1)
    if (SEMVER_RE.test(version)) return { name: spec.slice(0, at), version }
  }
  return { name: spec, version: null }
}

export function parseRangeFloor(range) {
  if (!range) return null
  const match = String(range).match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)
  return match ? match[1] : null
}

export function classifyDrift(pinned, latest) {
  if (!pinned || !latest) return "unknown"
  const a = SEMVER_RE.exec(pinned)
  const b = SEMVER_RE.exec(latest)
  if (!a || !b) return "unknown"
  if (Number(a[1]) !== Number(b[1])) return "major"
  if (Number(a[2]) !== Number(b[2])) return "minor"
  if (Number(a[3]) !== Number(b[3])) return "patch"
  return "none"
}

export function parseAdapterSource(source) {
  const candidates = new Map()

  function add(name, version, exact = false) {
    if (!name || name.startsWith("@agentproto/")) return
    const current = candidates.get(name)
    if (!current) {
      candidates.set(name, { name, version: version ?? null, exact })
      return
    }
    if (!current.exact && exact) {
      current.version = version
      current.exact = true
    } else if (!current.version && version) {
      current.version = version
    }
  }

  const bin = source.match(/\bbin:\s*["']([^"']+)["']/)?.[1] ?? null
  const binArgsBlock = source.match(/\bbin_args:\s*\[([^\]]*)\]/)?.[1] ?? ""
  const binArgs = [...binArgsBlock.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])

  for (const match of source.matchAll(
    /method:\s*["']([^"']+)["']\s*,\s*(?:package|url):\s*["']([^"']+)["']/g,
  )) {
    if (match[1] !== "npm") continue
    const { name, version } = splitPackageSpec(match[2])
    add(name, version, Boolean(version))
  }

  if (bin === "npx") {
    const target = binArgs.find((arg) => !arg.startsWith("-"))
    if (target) {
      const { name, version } = splitPackageSpec(target)
      add(name, version, Boolean(version))
    }
  }

  const versionCheck = source.match(/version_check:\s*\{([\s\S]*?)\}\s*,/)?.[1] ?? ""
  const range = versionCheck.match(/range:\s*["']([^"']+)["']/)?.[1]
  const rangeFloor = parseRangeFloor(range)
  const cmdMatch = versionCheck.match(/cmd:\s*(?:\[([^\]]*)\]|["']([^"']*)["'])/)
  const cmd = cmdMatch ? (cmdMatch[1] ?? cmdMatch[2] ?? "") : ""
  const npmView = cmd.match(/\bnpm\s+view\s+([^\s"']+)\s+version/)
  const npmLs = cmd.match(/\bnpm\s+ls\s+-g\s+([^\s"']+)/)
  const versionCheckPackage = npmView?.[1] ?? npmLs?.[1] ?? null

  if (versionCheckPackage) {
    add(splitPackageSpec(versionCheckPackage).name, null, false)
  }

  const names = [...candidates.keys()]
  for (const candidate of candidates.values()) {
    if (candidate.version) continue
    if (versionCheckPackage && candidate.name === versionCheckPackage) {
      candidate.version = rangeFloor
    } else if (!versionCheckPackage && names.length === 1) {
      candidate.version = rangeFloor
    }
  }

  return names
    .sort()
    .map((name) => candidates.get(name))
    .filter((candidate) => candidate.version)
    .map((candidate) => ({ package: candidate.name, pinned: candidate.version }))
}

export function collectPins(adaptersDir = DEFAULT_ADAPTERS_DIR) {
  const pins = []
  const skipped = []

  for (const entry of readdirSync(adaptersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(adaptersDir, entry.name, "src", "index.ts")
    if (!existsSync(file)) continue
    const parsed = parseAdapterSource(readFileSync(file, "utf8"))
    if (parsed.length === 0) {
      skipped.push(entry.name)
      continue
    }
    for (const pin of parsed) pins.push({ adapter: entry.name, ...pin })
  }

  pins.sort((a, b) => a.adapter.localeCompare(b.adapter) || a.package.localeCompare(b.package))
  skipped.sort()
  return { pins, skipped }
}

async function fetchLatestStable(pkg) {
  try {
    const { stdout } = await execFileAsync("npm", ["view", pkg, "version"], {
      encoding: "utf8",
      timeout: 30_000,
    })
    const value = stdout.trim().split(/\s+/).pop() ?? ""
    const match = SEMVER_RE.exec(value)
    if (!match || match[4]) return null
    return value
  } catch {
    return null
  }
}

export async function buildRows(pins, lookupLatest = fetchLatestStable) {
  const cache = new Map()
  const rows = []
  for (const pin of pins) {
    let latest = cache.get(pin.package)
    if (latest === undefined) {
      latest = await lookupLatest(pin.package)
      cache.set(pin.package, latest)
    }
    rows.push({ ...pin, latest, drift: classifyDrift(pin.pinned, latest) })
  }
  return rows
}

export function renderTable(rows) {
  const headers = ["adapter", "package", "pinned", "latest", "drift"]
  const body = rows.map((row) => [
    row.adapter,
    row.package,
    row.pinned,
    row.latest ?? "unavailable",
    row.drift,
  ])
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...body.map((cells) => cells[i].length)),
  )
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ")
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n")
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const asJson = args.has("--json")
  const strict = args.has("--strict")
  const { pins, skipped } = collectPins()
  const rows = await buildRows(pins)

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ rows, skipped }, null, 2)}\n`)
  } else {
    console.log(renderTable(rows))
    if (skipped.length > 0) {
      console.log(`\nNo npm pin: ${skipped.join(", ")}`)
    }
  }

  if (strict && rows.some((row) => row.drift !== "none" && row.drift !== "unknown")) {
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
