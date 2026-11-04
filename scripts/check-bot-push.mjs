#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const DEFAULT_ALLOWLIST = ["release.yml", "update-deps.yml"]
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function runBlocks(text) {
  const lines = text.split("\n")
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i])
    if (!match) continue
    const indent = match[1].length
    const inline = match[2]
    const startLine = i + 1
    if (!/^[|>][-+0-9]*\s*(?:#.*)?$/.test(inline)) {
      blocks.push({ line: startLine, body: inline, inline: true })
      continue
    }
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (!next.trim()) {
        body.push("")
        continue
      }
      const nextIndent = next.length - next.trimStart().length
      if (nextIndent <= indent) break
      body.push(next)
      i = j
    }
    blocks.push({ line: startLine, body: body.join("\n"), startsAt: startLine + 1 })
  }
  return blocks
}

export function findPushSites(text) {
  const sites = []
  for (const block of runBlocks(text)) {
    const lines = block.body.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*#/.test(line)) continue
      if (/(?:^|\s)git\s+push\b/.test(line)) {
        sites.push({
          line: block.inline ? block.line : block.startsAt + i,
          command: line.trim(),
        })
      }
    }
  }
  return sites
}

export function findViolations({ root = ROOT, allowlist = DEFAULT_ALLOWLIST } = {}) {
  const dir = path.join(root, ".github", "workflows")
  const files = readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  const allowed = new Set(allowlist)
  const violations = []
  for (const file of files.sort()) {
    if (allowed.has(file)) continue
    const text = readFileSync(path.join(dir, file), "utf8")
    for (const site of findPushSites(text)) {
      violations.push({ file, line: site.line, command: site.command })
    }
  }
  return violations
}

export function main(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      args[key] = next
      i++
    } else {
      args[key] = true
    }
  }
  const allowlist = args.allowlist
    ? String(args.allowlist).split(",").map((entry) => entry.trim()).filter(Boolean)
    : DEFAULT_ALLOWLIST
  const violations = findViolations({ root: args.root ? path.resolve(args.root) : ROOT, allowlist })
  if (violations.length === 0) {
    console.log("check-bot-push: no direct push sites outside the allowlist")
    return 0
  }
  for (const violation of violations) {
    console.error(
      `::error file=.github/workflows/${violation.file},line=${violation.line}::direct push outside the allowlist: ${violation.command}`,
    )
  }
  console.error(
    `check-bot-push: ${violations.length} direct push site(s) must use scripts/agentflow/bot-push.mjs or be added to the allowlist`,
  )
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
