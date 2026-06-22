#!/usr/bin/env node
/**
 * Auto-generate a changeset by asking Claude to analyse the git diff.
 *
 * Usage:
 *   node scripts/auto-changeset.mjs          # uses ANTHROPIC_API_KEY from env
 *   ANTHROPIC_API_KEY=sk-... node scripts/auto-changeset.mjs
 *
 * The script:
 *   1. Finds all @agentproto/* packages touched since origin/main
 *   2. Sends a truncated diff to Claude (claude-haiku-4-5) for analysis
 *   3. Writes .changeset/<slug>.md and exits 0
 *
 * Exit codes:
 *   0  — changeset written (or already exists — nothing to do)
 *   1  — error (no API key, Claude call failed, no packages changed, etc.)
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadAgentflowConfig, resolveEngine } from './agentflow/config.mjs'
import { runLlm, parseJsonLoose } from './agentflow/llm.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

// Engine is config-driven (.agentflow.json / .agentflow.local.json), with
// `--engine local|cloud` as an override. Local = Claude Code CLI.
const ENGINE_FLAG = (() => {
  const i = process.argv.indexOf('--engine')
  return i !== -1 ? process.argv[i + 1] : undefined
})()
const AGENTFLOW = loadAgentflowConfig(ROOT)

// ── helpers ──────────────────────────────────────────────────────────────────

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function randomSlug() {
  const words = [
    'amber', 'azure', 'beige', 'brass', 'cedar', 'coral', 'denim', 'dusty',
    'ember', 'fern', 'flint', 'frost', 'gold', 'hazel', 'ivory', 'jade',
    'khaki', 'lemon', 'lilac', 'linen', 'maple', 'mocha', 'navy', 'ochre',
    'olive', 'pearl', 'pine', 'plum', 'ruby', 'russet', 'sage', 'sand',
    'slate', 'stone', 'teal', 'umber', 'viola', 'wheat',
  ]
  const nouns = [
    'ants', 'bears', 'bees', 'birds', 'bison', 'boars', 'bucks', 'cats',
    'crabs', 'crane', 'doves', 'ducks', 'eagle', 'elks', 'finch', 'foxes',
    'frogs', 'geese', 'gnats', 'hawks', 'ibis', 'larks', 'lions', 'lynx',
    'moles', 'moose', 'moths', 'mules', 'owls', 'quail', 'rats', 'ravens',
    'seals', 'slugs', 'snail', 'stoat', 'swans', 'toads', 'trout', 'voles',
    'wasps', 'wolves', 'wrens', 'yaks', 'zebra',
  ]
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
  return `${pick(words)}-${pick(nouns)}-auto`
}

// ── guard: already exists? ────────────────────────────────────────────────────

const csDir = resolve(ROOT, '.changeset')
const existing = readdirSync(csDir)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .filter((f) => {
    // only count files added in this branch (not already on main).
    // Use execSync with stdio:'pipe' so git show errors don't leak to stderr.
    try {
      execSync(`git show origin/main:.changeset/${f}`, { cwd: ROOT, stdio: 'pipe' })
      return false // exists on main → not new
    } catch {
      return true // not on main → added in this branch
    }
  })

if (existing.length > 0) {
  console.log(`✓ Changeset already present: ${existing.join(', ')} — nothing to do.`)
  process.exit(0)
}

// ── discover changed packages ─────────────────────────────────────────────────

const changedFiles = run('git diff --name-only origin/main...HEAD').split('\n').filter(Boolean)

// Map file paths → package names by reading their package.json
const pkgDirs = [
  ...run('find packages -maxdepth 2 -name "package.json" -not -path "*/node_modules/*"')
    .split('\n')
    .filter(Boolean),
  ...run('find adapters -maxdepth 2 -name "package.json" -not -path "*/node_modules/*"')
    .split('\n')
    .filter(Boolean),
]

const pkgMap = new Map() // prefix → package name
for (const pkgJson of pkgDirs) {
  try {
    const { name, private: priv } = JSON.parse(readFileSync(resolve(ROOT, pkgJson), 'utf8'))
    if (name && name.startsWith('@agentproto/') && !priv) {
      const prefix = pkgJson.replace('/package.json', '') + '/'
      pkgMap.set(prefix, name)
    }
  } catch {}
}

const touchedPackages = new Set()
for (const file of changedFiles) {
  for (const [prefix, name] of pkgMap) {
    if (file.startsWith(prefix)) {
      touchedPackages.add(name)
    }
  }
}

if (touchedPackages.size === 0) {
  console.log('No @agentproto/* packages changed — no changeset needed.')
  process.exit(0)
}

console.log(`Packages changed: ${[...touchedPackages].join(', ')}`)

// ── build diff for Claude (cap at 12k chars) ─────────────────────────────────

const rawDiff = run(
  'git diff origin/main...HEAD -- "packages/**" "adapters/**"'
).slice(0, 12_000)

// ── call the model (engine-routed) ─────────────────────────────────────────────

const engine = resolveEngine(AGENTFLOW.changeset, { flag: ENGINE_FLAG })

const systemPrompt = `You are a release engineer for the @agentproto npm monorepo.
Given a git diff and a list of changed packages, produce a changeset.

Bump rules:
- patch: bug fix, internal refactor, test, docs, dependency bump, dead code removal
- minor: new exported function/type/class, new optional parameter, new feature (backward-compatible)
- major: removed export, renamed export, changed function signature incompatibly, breaking behavior change

Reply ONLY with valid JSON — no markdown fences, no explanation:
{
  "packages": [{ "name": "@agentproto/xxx", "bump": "patch|minor|major" }],
  "summary": "imperative-mood one-liner (≤ 72 chars)"
}

The "summary" becomes the CHANGELOG entry. Write it like a git commit subject.`

const userPrompt = `Changed packages: ${[...touchedPackages].join(', ')}

Diff (may be truncated):
${rawDiff}`

console.log(`Calling Claude to analyse the diff… (engine: ${engine})`)

let raw
try {
  raw = await runLlm({
    system: systemPrompt,
    user: userPrompt,
    engine,
    model: AGENTFLOW.changeset.model ?? undefined,
    claudeBin: AGENTFLOW.changeset.command ?? 'claude',
  })
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

let parsed
try {
  parsed = parseJsonLoose(raw)
} catch {
  console.error('Failed to parse model response as JSON:', raw)
  process.exit(1)
}

const { packages, summary } = parsed
if (!Array.isArray(packages) || !summary) {
  console.error('Unexpected response shape:', parsed)
  process.exit(1)
}

// ── write changeset ───────────────────────────────────────────────────────────

const frontmatter = packages.map((p) => `"${p.name}": ${p.bump}`).join('\n')
const slug = randomSlug()
const outPath = resolve(csDir, `${slug}.md`)

writeFileSync(outPath, `---\n${frontmatter}\n---\n\n${summary}\n`)

console.log(`✓ Written: .changeset/${slug}.md`)
console.log(`  Packages: ${packages.map((p) => `${p.name}@${p.bump}`).join(', ')}`)
console.log(`  Summary:  ${summary}`)
