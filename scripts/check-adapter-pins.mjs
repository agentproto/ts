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

export function compareSemver(left, right) {
  const a = SEMVER_RE.exec(left)
  const b = SEMVER_RE.exec(right)
  if (!a || !b) return null
  for (const index of [1, 2, 3]) {
    const delta = Number(a[index]) - Number(b[index])
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  if (a[4] === b[4]) return 0
  if (!a[4]) return 1
  if (!b[4]) return -1
  return a[4] < b[4] ? -1 : 1
}

export function classifyDrift(pinned, latest) {
  if (!pinned || !latest) return "unknown"
  const comparison = compareSemver(pinned, latest)
  if (comparison === null) return "unknown"
  if (comparison === 0) return "none"
  if (comparison > 0) return "ahead"
  const a = SEMVER_RE.exec(pinned)
  const b = SEMVER_RE.exec(latest)
  if (Number(a[1]) !== Number(b[1])) return "major"
  if (Number(a[2]) !== Number(b[2])) return "minor"
  return "patch"
}

function extractBalanced(source, start, open, close) {
  let depth = 0
  let quote = null
  let escaped = false
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2)
      i = end === -1 ? source.length : end
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === open) depth++
    else if (char === close) {
      depth--
      if (depth === 0) return source.slice(start + 1, i)
    }
  }
  return null
}

function extractAfter(source, key, open, close) {
  const match = new RegExp(`\\b${key}\\s*:\\s*\\${open}`).exec(source)
  if (!match) return null
  const start = match.index + match[0].length - 1
  return extractBalanced(source, start, open, close)
}

function extractObjects(block) {
  if (!block) return []
  const objects = []
  let index = block.indexOf("{")
  while (index !== -1) {
    const body = extractBalanced(block, index, "{", "}")
    if (body === null) break
    objects.push(body)
    const end = index + body.length + 2
    index = block.indexOf("{", end)
  }
  return objects
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
  const binArgsBlock = extractAfter(source, "bin_args", "[", "]") ?? ""
  const binArgs = [...binArgsBlock.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])

  for (const object of extractObjects(extractAfter(source, "install", "[", "]"))) {
    const method = object.match(/\bmethod:\s*["']([^"']+)["']/)?.[1]
    if (method !== "npm") continue
    const spec = object.match(/\bpackage:\s*["']([^"']+)["']/)?.[1]
    if (!spec) continue
    const { name, version } = splitPackageSpec(spec)
    add(name, version, Boolean(version))
  }

  if (bin === "npx") {
    const target = binArgs.find((arg) => !arg.startsWith("-"))
    if (target) {
      const { name, version } = splitPackageSpec(target)
      add(name, version, Boolean(version))
    }
  }

  const versionCheck = extractAfter(source, "version_check", "{", "}") ?? ""
  const range = versionCheck.match(/\brange:\s*["']([^"']+)["']/)?.[1]
  const rangeFloor = parseRangeFloor(range)
  const cmdMatch = versionCheck.match(/\bcmd:\s*(?:\[([^\]]*)\]|["']([^"']*)["'])/)
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

export function summarizeRows(rows) {
  const drifted = rows.filter((row) => row.drift !== "none" && row.drift !== "unknown")
  const unknown = rows.filter((row) => row.drift === "unknown")
  const current = rows.filter((row) => row.drift === "none")
  return {
    drifted,
    unknown,
    current,
    indeterminate: unknown.length > 0,
    fresh: drifted.length === 0 && unknown.length === 0,
  }
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
  const summary = summarizeRows(rows)

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ rows, skipped, summary }, null, 2)}\n`)
  } else {
    console.log(renderTable(rows))
    if (skipped.length > 0) {
      console.log(`\nNo npm pin: ${skipped.join(", ")}`)
    }
  }

  if (strict && summary.drifted.length > 0) {
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
