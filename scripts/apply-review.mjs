#!/usr/bin/env node
/**
 * Agentic review fixer — reads the latest CHANGES_REQUESTED review and
 * applies the requested changes to the working tree.
 *
 * Usage (always invoked by the pr-fix CI job):
 *   node scripts/apply-review.mjs
 *
 * Env:
 *   ANTHROPIC_API_KEY  — required
 *   GITHUB_TOKEN       — required (gh CLI picks it up automatically)
 *   PR_NUMBER          — required
 *
 * Exit codes:
 *   0 — changes applied to working tree (CI will commit + push), OR
 *       loop exhausted and escalation comment posted (nothing to commit)
 *   1 — unexpected error
 */

import { execSync, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

// ROOT detection: operate on caller's cwd when invoked from a worktree,
// fall back to the script's own repo root. Mirrors review-pr.mjs.
function findGitRoot(start) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: start, encoding: 'utf8', stdio: 'pipe',
    }).trim()
  } catch { return null }
}
const ROOT =
  findGitRoot(process.cwd()) ??
  findGitRoot(new URL('..', import.meta.url).pathname) ??
  new URL('..', import.meta.url).pathname.replace(/\/$/, '')

// ── constants ─────────────────────────────────────────────────────────────────

const MAX_ITER = 3
// Sentinel string matched in commit messages to count past iterations.
const FIX_COMMIT_MARKER = 'auto-fix from review'

// ── validate env ──────────────────────────────────────────────────────────────

const PR_NUMBER = process.env.PR_NUMBER
const apiKey = process.env.ANTHROPIC_API_KEY

if (!PR_NUMBER) {
  console.error('Error: PR_NUMBER env var is required.')
  process.exit(1)
}
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY env var is required.')
  process.exit(1)
}

// ── helpers ───────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
  } catch { return '' }
}

/**
 * Count how many fix-iteration commits already exist on this branch.
 * Primary source: gh PR commits list (exact, handles rebases).
 * Fallback: local git log grep.
 */
function countPastIterations() {
  try {
    const { commits } = JSON.parse(
      execFileSync('gh', ['pr', 'view', PR_NUMBER, '--json', 'commits'], {
        cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
      })
    )
    return (commits ?? []).filter((c) =>
      c.messageHeadline.includes(FIX_COMMIT_MARKER)
    ).length
  } catch {
    const log = run(
      `git log --oneline --grep="${FIX_COMMIT_MARKER}" origin/main..HEAD`
    )
    return log ? log.split('\n').filter(Boolean).length : 0
  }
}

// ── tool implementations ──────────────────────────────────────────────────────

function tool_git_diff({ maxChars = 40_000 } = {}) {
  try {
    const diff = execFileSync('gh', ['pr', 'diff', PR_NUMBER, '--patch'], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
    }).trim()
    if (!diff) return '(no diff)'
    return diff.length > maxChars
      ? diff.slice(0, maxChars) + `\n\n... (truncated at ${maxChars} chars)`
      : diff
  } catch {
    return '(could not fetch PR diff)'
  }
}

function tool_get_review() {
  try {
    // All reviews for the PR — pick the latest CHANGES_REQUESTED one.
    const reviews = JSON.parse(
      execFileSync(
        'gh',
        ['api', `repos/{owner}/{repo}/pulls/${PR_NUMBER}/reviews`, '--paginate'],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }
      )
    )
    const changesReq = [...reviews]
      .reverse()
      .find((r) => r.state === 'CHANGES_REQUESTED')
    if (!changesReq) return '(no CHANGES_REQUESTED review found)'

    // Inline review comments for the whole PR (gh returns all; filter by review id).
    const allComments = JSON.parse(
      execFileSync(
        'gh',
        ['api', `repos/{owner}/{repo}/pulls/${PR_NUMBER}/comments`],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }
      )
    )
    const inline = allComments
      .filter((c) => c.pull_request_review_id === changesReq.id)
      .map((c) => {
        const line = c.original_line ?? c.line ?? '?'
        return `**${c.path}** line ${line}:\n> ${c.body.replace(/\n/g, '\n> ')}`
      })
      .join('\n\n')

    return [
      `## Review body (id: ${changesReq.id})\n${changesReq.body || '(no body)'}`,
      inline ? `## Inline comments\n${inline}` : '(no inline comments)',
    ].join('\n\n')
  } catch (e) {
    return `(error fetching review: ${e.message})`
  }
}

function tool_read_file({ path }) {
  if (!path) return '(no path provided)'
  const abs = resolve(ROOT, path)
  if (!existsSync(abs)) return `(file not found: ${path})`
  try {
    const content = readFileSync(abs, 'utf8')
    return content.length > 8_000
      ? content.slice(0, 8_000) + '\n... (truncated at 8000 chars)'
      : content
  } catch {
    return `(could not read: ${path})`
  }
}

function tool_write_file({ path, content }) {
  if (!path || content === undefined) {
    return '(invalid args: path and content are both required)'
  }
  const abs = resolve(ROOT, path)
  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    return `Written: ${path}`
  } catch (e) {
    return `(write error: ${e.message})`
  }
}

function tool_gh_pr_comment({ body }) {
  if (!body) return '(no body provided)'
  try {
    execFileSync('gh', ['pr', 'comment', PR_NUMBER, '--body', body], {
      cwd: ROOT, encoding: 'utf8',
    })
    return `Comment posted on PR #${PR_NUMBER}`
  } catch (e) {
    return `(error posting comment: ${e.message})`
  }
}

// ── tool dispatch ─────────────────────────────────────────────────────────────

const TOOLS = {
  git_diff: tool_git_diff,
  get_review: tool_get_review,
  read_file: tool_read_file,
  write_file: tool_write_file,
  gh_pr_comment: tool_gh_pr_comment,
}

const TOOL_DEFS = [
  {
    name: 'git_diff',
    description: 'Get the full unified diff of the PR (patches, origin/main → branch HEAD).',
    input_schema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Truncate diff at this many chars (default: 40000)' },
      },
    },
  },
  {
    name: 'get_review',
    description: 'Fetch the latest CHANGES_REQUESTED review: body + inline comments with file path, line number, and text.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_file',
    description: 'Read a file from the working tree (path relative to repo root, truncated at 8000 chars).',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
      },
    },
  },
  {
    name: 'write_file',
    description: 'Overwrite a file in the working tree with new content. Use this to apply fixes. Always write the COMPLETE file content.',
    input_schema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'Complete new file content (not a diff)' },
      },
    },
  },
  {
    name: 'gh_pr_comment',
    description: 'Post a markdown comment on the PR. Reserved for escalation notices — do not use for status updates.',
    input_schema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: { type: 'string', description: 'Markdown comment body' },
      },
    },
  },
]

// ── system prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an agentic fixer for the @agentproto/ts monorepo.
Your sole job is to address EVERY change requested in the latest PR review and write the fixed files.

## Workflow — follow this order exactly

1. Call \`git_diff\` to understand what the PR changes.
2. Call \`get_review\` to read the CHANGES_REQUESTED review body and all inline comments.
3. For each file mentioned in the review, call \`read_file\` to see its current content.
4. Call \`write_file\` for each file that needs changes, providing the COMPLETE corrected content.
   - Do not truncate — always write the full file.
   - Address every comment. If a comment is ambiguous, make the minimal change that satisfies the intent.
   - Do not make unrelated changes.
5. Stop. Do NOT post a review comment — the CI reviewer handles that in a separate job.

## Constraints
- Only modify files explicitly mentioned in the review, or files that must change to satisfy a comment.
- Written files must be syntactically valid TypeScript / JavaScript / YAML / Markdown.
- Never call \`gh_pr_comment\` (it is reserved for the caller's escalation logic).
`

// ── Anthropic client (matches review-pr.mjs) ──────────────────────────────────

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
      max_tokens: 8192,
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

// ── agentic loop ──────────────────────────────────────────────────────────────

async function runAgenticLoop(iterNum) {
  const messages = [
    {
      role: 'user',
      content:
        `Please fix all review comments on PR #${PR_NUMBER}. ` +
        `This is fix iteration ${iterNum} of ${MAX_ITER} max. ` +
        `Start with git_diff and get_review, then read each relevant file, ` +
        `then apply all requested changes with write_file.`,
    },
  ]

  let turn = 0
  const MAX_TURNS = 20

  while (turn < MAX_TURNS) {
    turn++
    console.log(`\n⟳  Turn ${turn}`)

    const resp = await callClaude(messages)
    messages.push({ role: 'assistant', content: resp.content })

    const toolUses = resp.content.filter((b) => b.type === 'tool_use')

    if (toolUses.length === 0) {
      const text = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      if (text) console.log('\n' + text)
      break
    }

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
    if (resp.stop_reason === 'end_turn') break
  }

  if (turn >= MAX_TURNS) {
    console.warn(`\n⚠️  Reached max agentic turns (${MAX_TURNS}) — stopping.`)
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔧 Review fixer starting — PR #${PR_NUMBER}`)

  const pastIter = countPastIterations()
  console.log(`   Fix iterations already on branch: ${pastIter}`)

  if (pastIter >= MAX_ITER) {
    console.log(
      `\n⚠️  Loop exhausted (${MAX_ITER} iterations without approval) — escalating to human.`
    )
    tool_gh_pr_comment({
      body:
        `⚠️ **Auto-fix loop exhausted** after ${MAX_ITER} iterations without approval.\n\n` +
        `The agentic fixer has applied ${MAX_ITER} rounds of changes but the reviewer still ` +
        `requests more changes. A human must now review the remaining comments and address them manually.\n\n` +
        `**To force-merge** (repository admins only, when you are confident the code is correct):\n` +
        `\`\`\`\ngh pr merge --admin ${PR_NUMBER}\n\`\`\``,
    })
    // Exit 0 — no files written, CI commit step will see nothing staged and skip.
    process.exit(0)
  }

  await runAgenticLoop(pastIter + 1)

  console.log('\n✅ Fixer complete — working tree updated. CI will commit and push.')
}

await main()
