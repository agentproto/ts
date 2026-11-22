#!/usr/bin/env node
/**
 * check-private-names: fail when a private product or repository name appears
 * in a tracked file or file path of this public repository.
 *
 * The list lives in scripts/private-names.json (`names`: case-insensitive
 * regular expressions; `exceptions`: repo-relative paths allowed to match,
 * empty by default). The config file itself is never scanned.
 *
 * Usage: node scripts/check-private-names.mjs [--config <file>]
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

/** Pure core: returns `[{file, line, text, name}]` for every match. */
export function findViolations({ files, readText, names, exceptions = [] }) {
  const res = names.map(n => ({ n, re: new RegExp(n, "i") }))
  const allowed = new Set(exceptions)
  const out = []
  for (const file of files) {
    if (allowed.has(file)) continue
    for (const { n, re } of res) if (re.test(file)) out.push({ file, line: 0, text: "(file path)", name: n })
    const text = readText(file)
    if (text === null) continue
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      for (const { n, re } of res) {
        if (re.test(lines[i])) out.push({ file, line: i + 1, text: lines[i].trim().slice(0, 140), name: n })
      }
    }
  }
  return out
}

function main() {
  const argv = process.argv.slice(2)
  const ci = argv.indexOf("--config")
  const configPath = ci >= 0 ? resolve(argv[ci + 1]) : join(HERE, "private-names.json")
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  const configRel = relative(ROOT, configPath)
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 1 << 28 })
    .toString()
    .split("\0")
    .filter(f => f && f !== configRel)
  const readText = f => {
    try {
      const buf = readFileSync(join(ROOT, f))
      return buf.includes(0) ? null : buf.toString("utf8")
    } catch {
      return null
    }
  }
  const violations = findViolations({ files, readText, names: config.names, exceptions: config.exceptions })
  if (violations.length === 0) {
    console.log(`check-private-names: ok (${files.length} files, ${config.names.length} names)`)
    return
  }
  console.error(`check-private-names: ${violations.length} private name(s) found in a public repository:`)
  for (const v of violations.slice(0, 200)) console.error(`  ${v.file}:${v.line}  [${v.name}]  ${v.text}`)
  if (violations.length > 200) console.error(`  ... and ${violations.length - 200} more`)
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
