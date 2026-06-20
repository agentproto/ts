#!/usr/bin/env node
/**
 * Agentic PR reviewer — analyze mode → submit_plan gate → post mode.
 *
 * Usage:
 *   node scripts/review-pr.mjs --pr 23          # review PR #23 and post
 *   node scripts/review-pr.mjs --pr 23 --dry-run # analyze only, print to stdout
 *   node scripts/review-pr.mjs --dry-run         # review current branch vs main
 *
 * Env:
 *   ANTHROPIC_API_KEY   — required
 *   GITHUB_TOKEN        — required for posting (not needed with --dry-run)
 *   PR_NUMBER           — alternative to --pr flag (used in CI)
 *
 * Exit codes:
 *   0 — review posted (or dry-run complete)
 *   1 — error
 */

import { execSync, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const prIdx = args.indexOf('--pr')
const PR_NUMBER =
  prIdx !== -1 ? args[prIdx + 1] : (process.env.PR_NUMBER ?? null)

if (!DRY_RUN && !PR_NUMBER) {
  console.error('Usage: review-pr.mjs [--pr <N>] [--dry-run]')
  console.error('Set PR_NUMBER env var or pass --pr <N> to post a review.')
  process.exit(1)
}

// ── helpers ───────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
  } catch (e) {
    return ''
  }
}

function randomSlug() {
  const adj = ['amber', 'azure', 'cedar', 'coral', 'ember', 'fern', 'frost',
    'jade', 'khaki', 'lemon', 'maple', 'mocha', 'ochre', 'olive', 'pearl',
    'plum', 'ruby', 'sage', 'slate', 'teal', 'viola', 'wheat']
  const noun = ['ants', 'bears', 'bees', 'crabs', 'doves', 'ducks', 'foxes',
    'frogs', 'hawks', 'larks', 'lions', 'moles', 'moths', 'owls', 'rats',
    'seals', 'slugs', 'swans', 'toads', 'trout', 'wasps', 'wrens']
  const pick = (a) => a[Math.floor(Math.random() * a.length)]
  return `${pick(adj)}-${pick(noun)}-review`
}

// ── tool implementations ──────────────────────────────────────────────────────

const BASE_REF = 'origin/main'

function tool_git_diff({ from = BASE_REF, to = 'HEAD', maxChars = 40_000 } = {}) {
  const diff = run(`git diff "${from}...${to}" -- "packages/**" "adapters/**" "scripts/**" ".github/**" "specs/**"`)
  if (!diff) return '(no diff)'
  return diff.length > maxChars
    ? diff.slice(0, maxChars) + `\n\n... (truncated at ${maxChars} chars)`
    : diff
}

function tool_git_log({ from = BASE_REF, to = 'HEAD' } = {}) {
  return run(`git log --oneline "${from}...${to}"`) || '(no commits)'
}

function tool_grep_repo({ pattern, glob = '' }) {
  if (!pattern) return '(no pattern provided)'
  const globFlag = glob ? `--glob '${glob}'` : ''
  try {
    const result = execSync(
      `grep -rn --include="*.ts" --include="*.mjs" --include="*.md" -m 5 ${JSON.stringify(pattern)} packages/ adapters/ scripts/ specs/ 2>/dev/null | head -40`,
      { cwd: ROOT, encoding: 'utf8' }
    ).trim()
    return result || '(no matches)'
  } catch {
    return '(no matches)'
  }
}

function tool_read_file({ path }) {
  if (!path) return '(no path)'
  const abs = resolve(ROOT, path)
  if (!existsSync(abs)) return `(file not found: ${path})`
  try {
    const content = readFileSync(abs, 'utf8')
    return content.length > 8_000
      ? content.slice(0, 8_000) + '\n... (truncated)'
      : content
  } catch {
    return `(could not read: ${path})`
  }
}

function tool_list_changed_packages() {
  const changedFiles = run(`git diff --name-only "${BASE_REF}...HEAD"`).split('\n').filter(Boolean)

  const pkgJsonPaths = run(
    'find packages adapters -maxdepth 3 -name "package.json" -not -path "*/node_modules/*"'
  ).split('\n').filter(Boolean)

  const pkgMap = new Map()
  for (const p of pkgJsonPaths) {
    try {
      const { name, private: priv } = JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
      if (name && name.startsWith('@agentproto/') && !priv) {
        pkgMap.set(p.replace('/package.json', '') + '/', name)
      }
    } catch {}
  }

  const touched = new Set()
  for (const f of changedFiles) {
    for (const [prefix, name] of pkgMap) {
      if (f.startsWith(prefix)) touched.add(name)
    }
  }

  return touched.size === 0
    ? '(no @agentproto packages changed)'
    : [...touched].join('\n')
}

function tool_write_changeset({ packages, summary }) {
  if (!Array.isArray(packages) || !summary) return '(invalid args)'
  const csDir = resolve(ROOT, '.changeset')

  // Remove any existing auto-generated changesets on this branch
  const existing = readdirSync(csDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .filter((f) => {
      try { run(`git show "${BASE_REF}:.changeset/${f}"`); return false } catch { return true }
    })
  for (const f of existing) {
    try {
      execSync(`git rm -f ".changeset/${f}"`, { cwd: ROOT, stdio: 'pipe' })
    } catch {
      // File tracked on branch but git rm can't stage the removal — just delete.
      const fp = resolve(csDir, f)
      if (existsSync(fp)) {
        execSync(`rm -f "${fp}"`, { cwd: ROOT, stdio: 'pipe' })
      }
    }
  }

  const frontmatter = packages.map((p) => `"${p.name}": ${p.bump}`).join('\n')
  const slug = randomSlug()
  const outPath = resolve(csDir, `${slug}.md`)
  writeFileSync(outPath, `---\n${frontmatter}\n---\n\n${summary}\n`)
  execSync(`git add ".changeset/${slug}.md"`, { cwd: ROOT })
  return `Written .changeset/${slug}.md`
}

function tool_gh_pr_comment({ body }) {
  if (DRY_RUN) {
    console.log('\n[DRY-RUN] Would post PR comment:\n---\n' + body + '\n---')
    return 'dry-run: comment not posted'
  }
  if (!PR_NUMBER) return '(no PR number — cannot comment)'
  try {
    execFileSync('gh', ['pr', 'comment', PR_NUMBER, '--body', body], { cwd: ROOT, encoding: 'utf8' })
    return `Comment posted on PR #${PR_NUMBER}`
  } catch (e) {
    return `Error posting comment: ${e.message}`
  }
}

function tool_gh_pr_review({ event, body }) {
  // event: APPROVE | REQUEST_CHANGES | COMMENT
  const validEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']
  if (!validEvents.includes(event)) return `(invalid event: ${event})`
  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] Would submit ${event} review:\n---\n${body}\n---`)
    return `dry-run: ${event} review not posted`
  }
  if (!PR_NUMBER) return '(no PR number)'
  try {
    const flags = ['pr', 'review', PR_NUMBER, '--' + event.toLowerCase().replace('_', '-')]
    if (body) flags.push('--body', body)
    execFileSync('gh', flags, { cwd: ROOT, encoding: 'utf8' })
    return `${event} review submitted on PR #${PR_NUMBER}`
  } catch (e) {
    return `Error submitting review: ${e.message}`
  }
}

// ── tool dispatch ─────────────────────────────────────────────────────────────

const TOOLS = {
  git_diff: tool_git_diff,
  git_log: tool_git_log,
  grep_repo: tool_grep_repo,
  read_file: tool_read_file,
  list_changed_packages: tool_list_changed_packages,
  write_changeset: tool_write_changeset,
  gh_pr_comment: tool_gh_pr_comment,
  gh_pr_review: tool_gh_pr_review,
}

const TOOL_DEFS = [
  {
    name: 'git_diff',
    description: 'Get unified diff between two git refs for packages/, adapters/, scripts/, .github/, specs/. Defaults to origin/main...HEAD.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Base ref (default: origin/main)' },
        to: { type: 'string', description: 'Head ref (default: HEAD)' },
        maxChars: { type: 'number', description: 'Truncate at this many chars (default: 40000)' },
      },
    },
  },
  {
    name: 'git_log',
    description: 'Get one-line commit log between two refs. Defaults to origin/main...HEAD.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
      },
    },
  },
  {
    name: 'grep_repo',
    description: 'Search the repo for a pattern across .ts, .mjs, and .md files (max 40 results, 5 per file).',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Grep pattern (basic regex)' },
        glob: { type: 'string', description: 'Optional file glob filter' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read a file relative to the repo root (truncated at 8000 chars).',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path relative to repo root' },
      },
    },
  },
  {
    name: 'list_changed_packages',
    description: 'List @agentproto/* public packages touched in this branch diff.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'write_changeset',
    description: 'Write a .changeset/<slug>.md file and stage it with git add. Replaces any existing branch changeset.',
    input_schema: {
      type: 'object',
      required: ['packages', 'summary'],
      properties: {
        packages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'bump'],
            properties: {
              name: { type: 'string', description: '@agentproto/package-name' },
              bump: { type: 'string', enum: ['patch', 'minor', 'major'] },
            },
          },
        },
        summary: { type: 'string', description: 'Imperative-mood one-liner (≤72 chars) for the CHANGELOG' },
      },
    },
  },
  {
    name: 'gh_pr_comment',
    description: 'Post a markdown comment on the PR.',
    input_schema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: { type: 'string', description: 'Markdown comment body' },
      },
    },
  },
  {
    name: 'gh_pr_review',
    description: 'Submit a GitHub PR review. event must be APPROVE, REQUEST_CHANGES, or COMMENT.',
    input_schema: {
      type: 'object',
      required: ['event', 'body'],
      properties: {
        event: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
        body: { type: 'string', description: 'Review body in markdown' },
      },
    },
  },
]

// ── system prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert code reviewer for the @agentproto/ts monorepo — a TypeScript implementation of open agent standards (AIPs).

You operate in two phases:

## Phase 1: Analyze
Call the available tools to understand the PR:
1. Start with \`git_log\` and \`git_diff\` to see what changed.
2. Call \`list_changed_packages\` to know the bump scope.
3. Use \`read_file\` and \`grep_repo\` to follow references, check call-sites, and understand context.
4. Form a clear picture of: correctness, type safety, AIP alignment, test coverage, and changeset accuracy.

## Phase 2: Act
When you have enough context, take ALL of the following actions in sequence:

1. Call \`write_changeset\` with an accurate package list and bump levels:
   - patch: bug fix, internal refactor, test, docs, CI, dependency bump
   - minor: new exported function/type/class, new optional parameter, new feature (backward-compatible)
   - major: removed/renamed export, incompatible signature change, breaking behavior

2. Call \`gh_pr_review\` with:
   - event: APPROVE if the PR looks correct and complete, REQUEST_CHANGES if something is wrong, COMMENT for observations only
   - body: a structured markdown review (see format below)

3. Optionally call \`gh_pr_comment\` for supplementary inline observations.

## Review format

\`\`\`markdown
## Summary
[1-3 sentence overview of what this PR does]

## Changeset
[Table: package | bump | reason]

## Findings

### [Category: Correctness / Type Safety / Tests / AIP alignment / Nits]
- [finding]

## Verdict
[LGTM ✅ / Changes needed ❌ / Observations 💬] — [one-sentence rationale]
\`\`\`

## Bump rules
- Changing a type that callers depend on → minor or major depending on breaking-ness
- Fixing a bug that was already exported behavior → patch
- Adding a new MCP tool verb → minor (new public surface)
- Adding a new exported function to an AIP package → minor
- CI / workflow / script changes → do NOT bump any package (omit from changeset)

## Changeset accuracy
The auto-changeset script only has a truncated diff (12k chars) — it often misses packages.
After calling \`list_changed_packages\`, verify each package is correctly accounted for.
If the diff shows a \`scripts/**\` or \`.github/**\` change but no package export changed, do NOT add a changeset entry for it.
`

// ── agentic loop ──────────────────────────────────────────────────────────────

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY is not set.')
  process.exit(1)
}

async function callClaude(messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFS,
      messages,
    }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Anthropic API ${response.status}: ${body}`)
  }
  return response.json()
}

async function runAgenticLoop() {
  console.log(`\n🔍 PR Reviewer starting${DRY_RUN ? ' (dry-run)' : ''}…`)
  if (PR_NUMBER) console.log(`   PR: #${PR_NUMBER}`)

  const messages = [
    {
      role: 'user',
      content: PR_NUMBER
        ? `Please review PR #${PR_NUMBER} on the @agentproto/ts monorepo. Start by calling git_log and git_diff to understand the changes, then explore further as needed before writing the changeset and submitting your review.`
        : `Please review the current branch (vs origin/main) of the @agentproto/ts monorepo. Start by calling git_log and git_diff, then explore further, then write the changeset and post your review (dry-run mode: print to stdout instead of posting).`,
    },
  ]

  let iterations = 0
  const MAX_ITER = 20

  while (iterations < MAX_ITER) {
    iterations++
    console.log(`\n⟳  Turn ${iterations}`)

    const resp = await callClaude(messages)
    messages.push({ role: 'assistant', content: resp.content })

    // Collect tool calls
    const toolUses = resp.content.filter((b) => b.type === 'tool_use')

    if (toolUses.length === 0) {
      // Model finished without calling tools
      const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      if (text) console.log('\n' + text)
      break
    }

    // Execute tools and collect results
    const toolResults = []
    for (const use of toolUses) {
      const fn = TOOLS[use.name]
      let result
      if (!fn) {
        result = `(unknown tool: ${use.name})`
      } else {
        console.log(`   🔧 ${use.name}(${Object.keys(use.input ?? {}).join(', ')})`)
        try {
          result = fn(use.input ?? {})
        } catch (e) {
          result = `(tool error: ${e.message})`
        }
        // Truncate long tool results to avoid ballooning context
        if (typeof result === 'string' && result.length > 12_000) {
          result = result.slice(0, 12_000) + '\n\n... (truncated)'
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: String(result),
      })
    }

    messages.push({ role: 'user', content: toolResults })

    // If stop reason is end_turn (no more tool calls requested), we're done
    if (resp.stop_reason === 'end_turn') break
  }

  if (iterations >= MAX_ITER) {
    console.warn(`\n⚠️  Reached max iterations (${MAX_ITER}) — stopping.`)
  }

  console.log('\n✅ Review complete.')
}

await runAgenticLoop()
