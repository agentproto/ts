#!/usr/bin/env node
/**
 * agentflow docs flow — keep the CLI tool-docs (`docs/cli/`) honest against the
 * CLI's actual surface, then let the `code` actor close the gaps.
 *
 * Same shape as the review-loop: a cheap deterministic pass feeds the two
 * primitives.
 *
 *   detect (deterministic)  ·  code (the ACTOR writes docs)  ·  review (the JUDGE)
 *
 * WHY detector + LLM actor, not a dumb sync: the gap is *structural* — a verb
 * shipped without a page, a `--version` example that drifted — so a parse finds
 * it exactly and cheaply. Writing a good page is prose, so the actor does that.
 * The `--check` gate is the point: a new verb with no doc page fails CI, so the
 * docs can't silently rot the way `cron` / `onboard` / `install-mcp` did.
 *
 * (This is NOT `scripts/docs-check.mjs` — that one is an autonomous LLM doc
 * editor. This is a deterministic coverage gate plus an agentflow fix flow.)
 *
 * Two tiers of gap, deliberately different severities:
 *   - a verb with NO doc page is an ERROR — `--check` exits 1. It's always
 *     fixable in the same PR that adds the verb, so it can gate safely.
 *   - a drifted `agentproto <ver>` example is a WARNING — surfaced + fixed by
 *     the actor, but it never fails the gate. A routine `changeset version`
 *     bump would otherwise red `pnpm test` on every branch (and the release
 *     PR itself, which CI can't auto-fix) for a stale example string.
 *
 * Modes:
 *   --check     detector only: print gaps, exit 1 on a MISSING PAGE (the gate).
 *   (default)   detect → code: the actor writes/updates what the detector found.
 *
 *   node scripts/agentflow/docs.mjs --check
 *   node scripts/agentflow/docs.mjs [--engine local|cloud]
 *   pnpm cli-docs:check   ·   pnpm cli-docs:ai
 *
 * Edits land in the working tree (uncommitted) — review the diff and commit,
 * then let `pnpm review:ai` (or CI's pr-review) judge it. This flow doesn't
 * self-review: the actor leaves an uncommitted/untracked diff, which the review
 * primitive (a committed `origin/main...HEAD` diff) can't see anyway.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadAgentflowConfig, resolveEngine } from './config.mjs'
import { runCode } from './primitives/code.mjs'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

const CLI_SRC = resolve(ROOT, 'packages/cli/src/cli.ts')
const CLI_PKG = resolve(ROOT, 'packages/cli/package.json')
const DOCS_DIR = resolve(ROOT, 'docs/cli')
const VERBS_DIR = join(DOCS_DIR, 'verbs')

// The ONLY exception to "one verb, one page": verbs that legitimately share
// another verb's page (a rendering variant, not a distinct operation). Keep
// this tiny and explicit — every entry is a decision to NOT write a page.
const PAGE_ALIASES = { 'chat-tui': 'chat', 'provider-preset': 'presets' }

// ── detector (deterministic, no LLM) ──────────────────────────────────────

/** Extract the `VERBS` set the dispatcher recognises, straight from source. */
export function parseVerbs(src) {
  const block = src.match(/const VERBS = new Set\(\[([\s\S]*?)\]\)/)
  if (!block) throw new Error('[agentflow] cli-docs: could not find the VERBS set in cli.ts')
  // Strip line comments first: a commented-out entry (`// "foo",`) must not
  // register as a phantom verb the gate then demands a `verbs/foo.md` for.
  const body = block[1].replace(/\/\/[^\n]*/g, '')
  return [...body.matchAll(/["']([a-z][a-z0-9-]*)["']/g)].map((m) => m[1])
}

/** Verbs whose `verbs/<verb>.md` page (or alias target) is absent. Pure. */
export function missingVerbPages(verbs, pageSlugs, aliases = PAGE_ALIASES) {
  const pages = pageSlugs instanceof Set ? pageSlugs : new Set(pageSlugs)
  return verbs.filter((v) => !pages.has(aliases[v] ?? v))
}

/** `agentproto <x.y.z>` tokens that disagree with `version`, scanned ONLY inside
 *  fenced code blocks. That scoping is the whole trick: a `--version` output
 *  example always lives in a ``` fence, while prose about a past release
 *  ("agentproto 0.5.0 introduced X") never does — so historical references are
 *  ignored by construction, with no per-line opt-out to maintain. Also skips
 *  "Node ≥ 20.9.0" and dependency versions (no `agentproto` prefix). Pure. */
export function findStaleVersions(text, version) {
  const RX = /agentproto\s+(\d+\.\d+\.\d+[\w.-]*)/g
  const out = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) continue
    for (const m of line.matchAll(RX)) {
      if (m[1] !== version) out.push({ found: m[1], expected: version })
    }
  }
  return out
}

function markdownFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) markdownFiles(full, out)
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

function detectDocGaps() {
  const verbs = parseVerbs(readFileSync(CLI_SRC, 'utf8'))
  const pageSlugs = existsSync(VERBS_DIR)
    ? readdirSync(VERBS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
    : []
  const missingVerbs = missingVerbPages(verbs, pageSlugs)

  const version = JSON.parse(readFileSync(CLI_PKG, 'utf8')).version
  const staleVersions = []
  for (const file of markdownFiles(DOCS_DIR)) {
    for (const hit of findStaleVersions(readFileSync(file, 'utf8'), version)) {
      staleVersions.push({ file: relative(ROOT, file), ...hit })
    }
  }
  return { version, verbs, missingVerbs, staleVersions }
}

// ── goal for the actor ─────────────────────────────────────────────────────

function buildGoal({ version, missingVerbs, staleVersions }) {
  const lines = [
    'You are updating the `agentproto` CLI tool-docs under `docs/cli/`. Make ONLY',
    'the changes below. Do not reformat unrelated files and do not create commits.',
    '',
    'Ground truth for every claim is the source, not guesswork:',
    '  - the verb dispatcher: `packages/cli/src/cli.ts`',
    '  - each verb\'s implementation + flags: `packages/cli/src/commands/<verb>.ts`',
    '  - the published version: `packages/cli/package.json` (currently ' + version + ').',
    '',
  ]

  if (missingVerbs.length) {
    lines.push(
      'MISSING PAGES — create `docs/cli/verbs/<verb>.md` for each of these verbs,',
      'reading its command source first so the flags/subcommands are accurate:',
      ...missingVerbs.map((v) => `  - ${v}  (source: packages/cli/src/commands/${v}.ts)`),
      '',
      'Match the house style of the EXISTING pages in `docs/cli/verbs/` exactly',
      '(read e.g. `verbs/tunnel.md` and `verbs/sessions.md` as templates): a plain',
      '`# <verb>` H1 (NO frontmatter — the site synthesises it), a one-line intro,',
      'subcommand/flag tables, and a short example. For verbs that already have a',
      'one-line entry in `docs/cli/README.md` (pack, policy, presets, worktree),',
      'promote that into the new dedicated page — same content, fuller form.',
      '',
      'Then update `docs/cli/README.md`: turn every newly-documented verb into a',
      'linked bullet `[`agentproto <verb>`](./verbs/<verb>.md) — …` in the Verbs',
      'list, keeping alphabetical order and replacing any inline (unlinked) entry.',
      '',
    )
  }

  if (staleVersions.length) {
    lines.push(
      'STALE VERSION EXAMPLES — each is a `--version`/CLI-output line in a code',
      'fence that drifted. Fix each to `' + version + '`:',
      ...staleVersions.map((s) => `  - ${s.file}: found "${s.found}", expected "${s.expected}"`),
      '',
    )
  }

  lines.push(
    'FINALLY refresh `docs/cli/CLI-AUDIT.md`: its Command Inventory table must list',
    'ALL verbs in the dispatcher\'s VERBS set (it is currently missing several).',
    'Update the "as of" date line to today and add rows for the absent verbs; keep',
    'the existing Findings section as-is unless a finding is now factually wrong.',
  )
  return lines.join('\n')
}

// ── flow ────────────────────────────────────────────────────────────────────

/** Missing pages are gate-failing; version drift is advisory (never reds the
 *  gate — a version bump would otherwise strand `pnpm test`). */
function isBlocking(gaps) {
  return gaps.missingVerbs.length > 0
}

function printGaps({ verbs, missingVerbs, staleVersions, version }) {
  console.log(`[agentflow] cli-docs: ${verbs.length} verbs, CLI version ${version}`)
  if (missingVerbs.length) {
    console.log(`  ✗ ${missingVerbs.length} verb(s) with no doc page: ${missingVerbs.join(', ')}`)
  }
  for (const s of staleVersions) {
    console.log(`  ⚠ stale example in ${s.file}: "${s.found}" (expected "${s.expected}") — advisory, run cli-docs:ai`)
  }
  if (!missingVerbs.length && !staleVersions.length) console.log('  ✓ docs in sync')
}

async function main() {
  const argv = process.argv.slice(2)
  const has = (f) => argv.includes(f)
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i !== -1 ? argv[i + 1] : undefined
  }

  const gaps = detectDocGaps()
  // A missing page fails the gate; a drifted example is worth the actor's time
  // (it can fix it) but must never block.
  const hasWork = gaps.missingVerbs.length > 0 || gaps.staleVersions.length > 0

  if (has('--check')) {
    printGaps(gaps)
    process.exit(isBlocking(gaps) ? 1 : 0)
  }

  printGaps(gaps)
  if (!hasWork) {
    console.log('[agentflow] cli-docs: nothing to write.')
    return
  }

  const cfg = loadAgentflowConfig(ROOT)
  const engine = resolveEngine(cfg.review, { flag: flag('--engine') })
  if (engine !== 'local') {
    console.error('[agentflow] cli-docs: the actor needs the local Claude CLI — set engine "local".')
    process.exit(1)
  }
  const model = cfg.review.model ?? undefined
  const claudeBin = cfg.review.command ?? 'claude'

  console.log('\n[agentflow] ── cli-docs: the actor is writing docs ──')
  const { ok } = runCode({
    goal: buildGoal(gaps),
    engine,
    claudeBin,
    model,
    root: ROOT,
    // New pages need Write; the rest is read + Edit. No Bash — docs only.
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  })
  if (!ok) {
    console.error('[agentflow] cli-docs: actor exited non-zero — inspect the working tree.')
    process.exit(1)
  }

  // The detector is the real acceptance test: re-run it and refuse to call the
  // job done while gaps remain.
  const after = detectDocGaps()
  console.log('\n[agentflow] ── cli-docs: re-checking coverage ──')
  printGaps(after)
  console.log('\n[agentflow] cli-docs: review the diff and commit, then `pnpm review:ai` (or CI) judges it.')

  process.exit(isBlocking(after) ? 1 : 0)
}

// Only run when invoked directly (`node docs.mjs …`) — importing the module for
// tests just pulls in the pure exports above, without touching the filesystem.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[agentflow] cli-docs: failed —', err)
    process.exit(1)
  })
}
