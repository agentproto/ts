#!/usr/bin/env node
/**
 * Developer toolbelt for the agent harness.
 *
 * Every capability the bot can use — read, search, edit, diff, run, and the
 * GitHub write surface (comment, review, open PR) — is a named tool here.
 * Flows assemble a subset via `buildToolset(names, ctx)`:
 *
 *   const { defs, impls } = buildToolset(
 *     ['git_diff', 'read_file', 'write_changeset', 'gh_pr_review'],
 *     { prNumber, dryRun, baseRef }
 *   )
 *
 * ctx:
 *   prNumber  — PR under review/fix (string|null). Required by gh_* tools.
 *   dryRun    — when true, write/post tools print instead of mutating.
 *   baseRef   — diff base (default 'origin/main').
 */

import { execSync, execFileSync } from 'node:child_process'
import {
  existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, mkdtempSync,
} from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { ROOT, run } from './agent-core.mjs'
import { buildFooter, MARKER } from './provenance-footer.mjs'
// `computeProvenance` lives in @agentproto/worktree's *built* dist. It is only
// needed on the PR-open footer path (gh_open_pr), so it is imported lazily at
// that call site — a static top-level import would crash module load in any job
// that runs a tools.mjs consumer without a built worktree package (e.g. the
// Auto-fix job, which runs apply-review.mjs --delivery commit and never opens a
// PR). See the dynamic import in gh_open_pr below.

/**
 * Map a raw SessionRef (as returned by computeProvenance) to the provenance
 * shape expected by buildFooter. This is the seam that was silently dropping
 * session id, adapter slug, and model because the field names differ.
 */
export function sessionRefToProv(primary) {
  return {
    sessionId: primary.id,
    label: primary.label,
    adapter: primary.adapterSlug,
    model: primary.model,
    costUsd: primary.costUsd,
    tokensIn: primary.tokensIn,
    tokensOut: primary.tokensOut,
    source: 'local',
  }
}

// ── GitHub GraphQL helper (Discussions API is GraphQL-only) ──────────────────
function ghGraphql(query, fields = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(fields)) {
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`)
  }
  return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function ownerRepo() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '/').split('/')
  return { owner, repo }
}

// ── allow-listed shell commands for run_command ──────────────────────────────
// Keep this tight: only the build/test/type-check verbs the agent needs to
// validate its own work. Anything else is rejected.
const ALLOWED_COMMANDS = [
  'pnpm build',
  'pnpm test',
  'pnpm check-types',
  'pnpm lint',
  'pnpm changeset status',
  'pnpm install --frozen-lockfile',
]

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

// ── tool definitions ──────────────────────────────────────────────────────────
// allTools(ctx) returns { name: { def, impl } }. buildToolset selects a subset.

function allTools(ctx) {
  const {
    prNumber = null, dryRun = false, baseRef = 'origin/main',
    discussionNumber = null, discussionNodeId = null,
  } = ctx

  // ---- read / search ----

  const git_diff = {
    def: {
      name: 'git_diff',
      description: 'Get unified diff for packages/, adapters/, scripts/, .github/, specs/. Defaults to the PR diff (origin/main...HEAD).',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Base ref (default: origin/main)' },
          to: { type: 'string', description: 'Head ref (default: HEAD)' },
          maxChars: { type: 'number', description: 'Truncate at this many chars (default: 40000)' },
        },
      },
    },
    impl: ({ from, to, maxChars = 40_000 } = {}) => {
      let diff
      if (prNumber && !from && !to) {
        try {
          diff = execFileSync('gh', ['pr', 'diff', prNumber, '--patch'], {
            cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
          }).trim()
        } catch { diff = '' }
      }
      if (!diff) {
        diff = run(
          `git diff "${from ?? baseRef}...${to ?? 'HEAD'}" -- "packages/**" "adapters/**" "scripts/**" ".github/**" "specs/**"`
        )
      }
      if (!diff) return '(no diff)'
      return diff.length > maxChars
        ? diff.slice(0, maxChars) + `\n\n... (truncated at ${maxChars} chars)`
        : diff
    },
  }

  const git_log = {
    def: {
      name: 'git_log',
      description: 'Get one-line commit log between two refs. Defaults to origin/main...HEAD.',
      input_schema: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
      },
    },
    impl: ({ from = baseRef, to = 'HEAD' } = {}) => {
      if (prNumber) {
        try {
          const info = JSON.parse(
            execFileSync('gh', ['pr', 'view', prNumber, '--json', 'commits'], {
              cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
            })
          )
          return (info.commits ?? [])
            .map((c) => `${c.oid.slice(0, 7)} ${c.messageHeadline}`)
            .join('\n') || '(no commits)'
        } catch {}
      }
      return run(`git log --oneline "${from}...${to}"`) || '(no commits)'
    },
  }

  const grep_repo = {
    def: {
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
    impl: ({ pattern }) => {
      if (!pattern) return '(no pattern provided)'
      try {
        const result = execSync(
          `grep -rn --include="*.ts" --include="*.mjs" --include="*.md" -m 5 ${JSON.stringify(pattern)} packages/ adapters/ scripts/ specs/ 2>/dev/null | head -40`,
          { cwd: ROOT, encoding: 'utf8' }
        ).trim()
        return result || '(no matches)'
      } catch {
        return '(no matches)'
      }
    },
  }

  const READ_PAGE = 60_000

  const read_file = {
    def: {
      name: 'read_file',
      description:
        `Read a file relative to the repo root. Returns up to ${READ_PAGE} chars; larger files are paged — ` +
        'pass `offset` to read the next slice. IMPORTANT: if the result is marked PARTIAL, you have NOT seen ' +
        'the whole file — do NOT overwrite it with write_file (you would drop the unseen part). Use edit_file ' +
        'for targeted changes, or page through with offset until you have the full content.',
      input_schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Path relative to repo root' },
          offset: { type: 'number', description: 'Byte offset to start reading from (default 0). Use to page large files.' },
        },
      },
    },
    impl: ({ path, offset = 0 }) => {
      if (!path) return '(no path)'
      const abs = resolve(ROOT, path)
      if (!existsSync(abs)) return `(file not found: ${path})`
      try {
        const content = readFileSync(abs, 'utf8')
        const start = Math.max(0, Math.trunc(offset))
        const slice = content.slice(start, start + READ_PAGE)
        const end = start + slice.length
        if (start === 0 && end >= content.length) return content
        const nextHint = end < content.length
          ? `call read_file again with offset:${end} for the next slice`
          : 'this is the final slice'
        return (
          `[PARTIAL view of ${path}: chars ${start}–${end} of ${content.length}. ` +
          `Do NOT write_file this file from a partial read — use edit_file for targeted changes; ${nextHint}.]\n` +
          slice
        )
      } catch {
        return `(could not read: ${path})`
      }
    },
  }

  const list_dir = {
    def: {
      name: 'list_dir',
      description: 'List entries of a directory relative to the repo root.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path (default: repo root)' } },
      },
    },
    impl: ({ path = '.' } = {}) => {
      const abs = resolve(ROOT, path)
      if (!existsSync(abs)) return `(not found: ${path})`
      try {
        return readdirSync(abs, { withFileTypes: true })
          .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
          .join('\n') || '(empty)'
      } catch (e) {
        return `(could not list: ${e.message})`
      }
    },
  }

  const list_changed_packages = {
    def: {
      name: 'list_changed_packages',
      description: 'List @agentproto/* public packages touched in this branch diff.',
      input_schema: { type: 'object', properties: {} },
    },
    impl: () => {
      const changedFiles = run(`git diff --name-only "${baseRef}...HEAD"`).split('\n').filter(Boolean)
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
      return touched.size === 0 ? '(no @agentproto packages changed)' : [...touched].join('\n')
    },
  }

  // ---- write / run ----

  // Refuse a whole-file overwrite that drops most of an existing file — the
  // classic "read was truncated, model rewrote what little it saw" data-loss
  // mode. Prefer edit_file for targeted changes; pass allowShrink for a
  // deletion the review genuinely asked for.
  const SHRINK_FLOOR_CHARS = 2_000
  const SHRINK_RATIO = 0.6

  const write_file = {
    def: {
      name: 'write_file',
      description:
        'Overwrite a file with the COMPLETE new content (not a diff). Use only to CREATE a new file or fully ' +
        'rewrite a SMALL one. For edits to an existing file prefer edit_file — write_file re-emits the whole ' +
        'file and will silently drop anything you did not include. A write that shrinks an existing file by ' +
        'more than 40% is refused unless allowShrink:true.',
      input_schema: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'File path relative to repo root' },
          content: { type: 'string', description: 'Complete new file content' },
          allowShrink: { type: 'boolean', description: 'Permit a >40% shrink of an existing file (only when the review explicitly asked to remove content). Default false.' },
        },
      },
    },
    impl: ({ path, content, allowShrink = false }) => {
      if (!path || content === undefined) return '(invalid args: path and content required)'
      const abs = resolve(ROOT, path)
      if (!allowShrink && existsSync(abs)) {
        try {
          const prev = readFileSync(abs, 'utf8')
          if (prev.length >= SHRINK_FLOOR_CHARS && content.length < prev.length * SHRINK_RATIO) {
            const pct = Math.round((content.length / prev.length) * 100)
            return (
              `(refused: write_file would shrink ${path} from ${prev.length} to ${content.length} chars ` +
              `(${pct}% of the original). This is the usual signature of content lost to a truncated read. ` +
              `Use edit_file for the targeted change. If the removal is genuinely requested by the review, ` +
              `re-call write_file with allowShrink:true.)`
            )
          }
        } catch { /* fall through to write */ }
      }
      if (dryRun) return `[dry-run] would write ${content.length} chars to ${path}`
      try {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content, 'utf8')
        return `Written: ${path}`
      } catch (e) {
        return `(write error: ${e.message})`
      }
    },
  }

  const edit_file = {
    def: {
      name: 'edit_file',
      description:
        'Surgically edit an existing file: replace an exact, unique substring (old_string) with new_string. ' +
        'PREFER THIS over write_file for any change to an existing file — it cannot drop unrelated content, and ' +
        'it works regardless of how large the file is or whether you read all of it. old_string must match the ' +
        'file byte-for-byte (including whitespace) and appear exactly once, unless replace_all is set.',
      input_schema: {
        type: 'object',
        required: ['path', 'old_string', 'new_string'],
        properties: {
          path: { type: 'string', description: 'File path relative to repo root' },
          old_string: { type: 'string', description: 'Exact text to replace; must be unique in the file (or set replace_all)' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match. Default false.' },
        },
      },
    },
    impl: ({ path, old_string, new_string, replace_all = false }) => {
      if (!path || old_string === undefined || new_string === undefined) {
        return '(invalid args: path, old_string, new_string required)'
      }
      const abs = resolve(ROOT, path)
      if (!existsSync(abs)) return `(file not found: ${path} — use write_file to create a new file)`
      if (old_string === new_string) return '(no-op: old_string and new_string are identical)'
      let prev
      try { prev = readFileSync(abs, 'utf8') } catch (e) { return `(could not read ${path}: ${e.message})` }
      const occurrences = prev.split(old_string).length - 1
      if (occurrences === 0) return `(old_string not found in ${path} — it must match byte-for-byte)`
      if (occurrences > 1 && !replace_all) {
        return `(old_string appears ${occurrences} times in ${path} — add surrounding context to make it unique, or pass replace_all:true)`
      }
      const next = replace_all ? prev.split(old_string).join(new_string) : prev.replace(old_string, new_string)
      if (dryRun) return `[dry-run] would edit ${path} (${occurrences} replacement${occurrences > 1 ? 's' : ''})`
      try {
        writeFileSync(abs, next, 'utf8')
        return `Edited ${path} (${occurrences} replacement${occurrences > 1 ? 's' : ''})`
      } catch (e) {
        return `(write error: ${e.message})`
      }
    },
  }

  const run_command = {
    def: {
      name: 'run_command',
      description: `Run an allow-listed build/validation command and return its output (truncated). Allowed: ${ALLOWED_COMMANDS.join(', ')}.`,
      input_schema: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'One of the allow-listed commands' },
          timeoutMs: { type: 'number', description: 'Timeout (default 600000)' },
        },
      },
    },
    impl: ({ command, timeoutMs = 600_000 }) => {
      if (!command) return '(no command)'
      const allowed = ALLOWED_COMMANDS.some((c) => command.trim() === c || command.trim().startsWith(c + ' '))
      if (!allowed) return `(command not allow-listed: ${command})\nAllowed: ${ALLOWED_COMMANDS.join(', ')}`
      try {
        const out = execSync(command, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, stdio: 'pipe' })
        const tail = out.trim()
        return `exit 0\n${tail.length > 8_000 ? tail.slice(-8_000) : tail}`
      } catch (e) {
        const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim()
        return `exit ${e.status ?? 1}\n${out.length > 8_000 ? out.slice(-8_000) : out}`
      }
    },
  }

  const write_changeset = {
    def: {
      name: 'write_changeset',
      description: 'Write a .changeset/<slug>.md file and stage it. Replaces any existing branch changeset. Idempotent per PR.',
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
    impl: ({ packages, summary }) => {
      if (!Array.isArray(packages) || !summary) return '(invalid args)'
      const csDir = resolve(ROOT, '.changeset')
      const slug = prNumber ? `pr-${prNumber}-review` : randomSlug()
      const outPath = resolve(csDir, `${slug}.md`)

      if (prNumber && existsSync(outPath)) {
        return `.changeset/${slug}.md already present — left as-is (idempotent)`
      }

      const existing = readdirSync(csDir)
        .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== `${slug}.md`)
        .filter((f) => {
          try {
            execSync(`git show "${baseRef}:.changeset/${f}"`, { cwd: ROOT, stdio: 'pipe' })
            return false
          } catch {
            return true
          }
        })
      for (const f of existing) {
        const fp = resolve(csDir, f)
        try {
          execSync(`git rm -f ".changeset/${f}"`, { cwd: ROOT, stdio: 'pipe' })
        } catch {
          if (existsSync(fp)) unlinkSync(fp)
        }
      }

      const frontmatter = packages.map((p) => `"${p.name}": ${p.bump}`).join('\n')
      writeFileSync(outPath, `---\n${frontmatter}\n---\n\n${summary}\n`)
      execSync(`git add ".changeset/${slug}.md"`, { cwd: ROOT })
      return `Written .changeset/${slug}.md`
    },
  }

  // ---- GitHub read ----

  const gh_get_pr = {
    def: {
      name: 'gh_get_pr',
      description: 'Read PR metadata: title, body, author, state, labels, base/head refs.',
      input_schema: {
        type: 'object',
        properties: { number: { type: 'string', description: 'PR number (default: current)' } },
      },
    },
    impl: ({ number } = {}) => {
      const n = number ?? prNumber
      if (!n) return '(no PR number)'
      try {
        const out = execFileSync('gh', ['pr', 'view', String(n), '--json',
          'title,body,author,state,labels,headRefName,baseRefName,isDraft'], {
          cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
        })
        return out.trim()
      } catch (e) {
        return `(error: ${e.message})`
      }
    },
  }

  const gh_get_issue = {
    def: {
      name: 'gh_get_issue',
      description: 'Read an issue: title, body, author, state, labels, and comments.',
      input_schema: {
        type: 'object',
        required: ['number'],
        properties: { number: { type: 'string', description: 'Issue number' } },
      },
    },
    impl: ({ number }) => {
      if (!number) return '(no issue number)'
      try {
        const out = execFileSync('gh', ['issue', 'view', String(number), '--json',
          'title,body,author,state,labels,comments'], {
          cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
        })
        return out.trim()
      } catch (e) {
        return `(error: ${e.message})`
      }
    },
  }

  const get_review = {
    def: {
      name: 'get_review',
      description: 'Fetch the latest CHANGES_REQUESTED review on the PR: body + inline comments with file path, line, and text.',
      input_schema: { type: 'object', properties: {} },
    },
    impl: () => {
      if (!prNumber) return '(no PR number)'
      try {
        const reviews = JSON.parse(
          execFileSync('gh', ['api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews`, '--paginate'],
            { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
        )
        const changesReq = [...reviews].reverse().find((r) => r.state === 'CHANGES_REQUESTED')
        if (!changesReq) return '(no CHANGES_REQUESTED review found)'
        const allComments = JSON.parse(
          execFileSync('gh', ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`],
            { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
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
    },
  }

  // ---- GitHub write ----

  const gh_pr_comment = {
    def: {
      name: 'gh_pr_comment',
      description: 'Post a markdown comment on the PR (or issue, with number).',
      input_schema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string', description: 'Markdown comment body' },
          number: { type: 'string', description: 'PR/issue number (default: current PR)' },
        },
      },
    },
    impl: ({ body, number } = {}) => {
      const n = number ?? prNumber
      if (!body) return '(no body)'
      if (dryRun) {
        console.log(`\n[dry-run] Would comment on #${n}:\n---\n${body}\n---`)
        return 'dry-run: comment not posted'
      }
      if (!n) return '(no PR/issue number)'
      try {
        execFileSync('gh', ['pr', 'comment', String(n), '--body', body], { cwd: ROOT, encoding: 'utf8' })
        return `Comment posted on #${n}`
      } catch (e) {
        // Fall back to issue comment (works for issues too).
        try {
          execFileSync('gh', ['issue', 'comment', String(n), '--body', body], { cwd: ROOT, encoding: 'utf8' })
          return `Comment posted on #${n}`
        } catch (e2) {
          return `(error posting comment: ${e2.message})`
        }
      }
    },
  }

  const gh_pr_review = {
    def: {
      name: 'gh_pr_review',
      description: 'Submit a GitHub PR review. event: APPROVE, REQUEST_CHANGES, or COMMENT.',
      input_schema: {
        type: 'object',
        required: ['event', 'body'],
        properties: {
          event: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
          body: { type: 'string', description: 'Review body in markdown' },
        },
      },
    },
    impl: ({ event, body }) => {
      const valid = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']
      if (!valid.includes(event)) return `(invalid event: ${event})`
      if (dryRun) {
        console.log(`\n[dry-run] Would submit ${event} review:\n---\n${body}\n---`)
        return `dry-run: ${event} review not posted`
      }
      if (!prNumber) return '(no PR number)'
      try {
        const flags = ['pr', 'review', prNumber, '--' + event.toLowerCase().replace('_', '-')]
        if (body) flags.push('--body', body)
        execFileSync('gh', flags, { cwd: ROOT, encoding: 'utf8' })
        return `${event} review submitted on PR #${prNumber}`
      } catch (e) {
        return `(error submitting review: ${e.message})`
      }
    },
  }

  const gh_open_pr = {
    def: {
      name: 'gh_open_pr',
      description: 'Create a branch from the current HEAD, commit all working-tree changes, push, and open a PR. Use to deliver changes as a reviewable PR.',
      input_schema: {
        type: 'object',
        required: ['branch', 'title', 'body'],
        properties: {
          branch: { type: 'string', description: 'New branch name, e.g. bot/fix-123' },
          title: { type: 'string', description: 'PR title' },
          body: { type: 'string', description: 'PR body (markdown)' },
          base: { type: 'string', description: 'Base branch to target (default: the current branch / PR head)' },
          commitMessage: { type: 'string', description: 'Commit message (default: derived from title)' },
        },
      },
    },
    impl: async ({ branch, title, body, base, commitMessage }) => {
      if (!branch || !title || !body) return '(invalid args: branch, title, body required)'
      if (dryRun) {
        console.log(`\n[dry-run] Would open PR "${title}" on branch ${branch} → ${base ?? 'current'}`)
        return `dry-run: PR not opened (branch ${branch})`
      }
      try {
        const currentBranch = run('git rev-parse --abbrev-ref HEAD')
        const target = base ?? currentBranch
        execSync('git config user.name "github-actions[bot]"', { cwd: ROOT })
        execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { cwd: ROOT })
        execSync(`git checkout -b "${branch}"`, { cwd: ROOT, stdio: 'pipe' })
        execSync('git add -A', { cwd: ROOT })
        const staged = run('git diff --cached --name-only')
        if (!staged) return '(nothing to commit — no PR opened)'
        const msg = commitMessage ?? title
        execFileSync('git', ['commit', '-m', msg], { cwd: ROOT, stdio: 'pipe' })
        execSync(`git push -u origin "${branch}"`, { cwd: ROOT, stdio: 'pipe' })
        const sha = run('git rev-parse HEAD')
        let stampedBody = body
        if (!body.includes(MARKER)) {
          try {
            const { computeProvenance } = await import('../../packages/worktree/dist/index.mjs')
            const provInfo = await computeProvenance(ROOT)
            const sessions = provInfo?.sessions ?? []
            const primary =
              sessions
                .filter((s) => s.adapterSlug)
                .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ??
              sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
            if (primary) {
              const suppressHost = process.env.AGENTFLOW_FOOTER_HOST === '0'
              const prov = sessionRefToProv(primary)
              if (!suppressHost) {
                prov.host = hostname()
                prov.cwd = ROOT
              }
              const footer = buildFooter({ prov, authMode: primary.authMode, sha, kind: 'PR' })
              stampedBody = `${body}${footer}`
            }
          } catch (err) {
            console.warn(`[gh_open_pr] provenance footer skipped: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        const url = execFileSync('gh', [
          'pr', 'create', '--base', target, '--head', branch, '--title', title, '--body', stampedBody,
        ], { cwd: ROOT, encoding: 'utf8' }).trim()
        return `Opened PR: ${url}`
      } catch (e) {
        return `(error opening PR: ${e.message})`
      }
    },
  }

  const gh_list_labels = {
    def: {
      name: 'gh_list_labels',
      description: 'List the labels that exist in this repository (name + description). Apply only labels from this list.',
      input_schema: { type: 'object', properties: {} },
    },
    impl: () => {
      try {
        const out = execFileSync('gh', ['label', 'list', '--limit', '100', '--json', 'name,description'],
          { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
        return out.trim() || '(no labels)'
      } catch (e) {
        return `(error listing labels: ${e.message})`
      }
    },
  }

  const gh_label = {
    def: {
      name: 'gh_label',
      description: 'Add (and/or remove) labels on an issue or PR. Use only labels that exist (call gh_list_labels first).',
      input_schema: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'Issue/PR number (default: current)' },
          add: { type: 'array', items: { type: 'string' }, description: 'Labels to add' },
          remove: { type: 'array', items: { type: 'string' }, description: 'Labels to remove' },
        },
      },
    },
    impl: ({ number, add = [], remove = [] } = {}) => {
      const n = number ?? prNumber
      if (!n) return '(no issue/PR number)'
      if (dryRun) return `[dry-run] would add [${add.join(', ')}] remove [${remove.join(', ')}] on #${n}`
      const flags = ['issue', 'edit', String(n)]
      for (const l of add) flags.push('--add-label', l)
      for (const l of remove) flags.push('--remove-label', l)
      if (add.length === 0 && remove.length === 0) return '(no labels specified)'
      try {
        execFileSync('gh', flags, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
        return `Labels updated on #${n} (+[${add.join(', ')}] -[${remove.join(', ')}])`
      } catch (e) {
        return `(error updating labels: ${e.message})`
      }
    },
  }

  // ---- GitHub Discussions (GraphQL) ----

  const gh_get_discussion = {
    def: {
      name: 'gh_get_discussion',
      description: 'Read a discussion: title, body, url, category, and comments.',
      input_schema: {
        type: 'object',
        properties: { number: { type: 'number', description: 'Discussion number (default: current)' } },
      },
    },
    impl: ({ number } = {}) => {
      const n = number ?? discussionNumber
      if (!n) return '(no discussion number)'
      const { owner, repo } = ownerRepo()
      const q = `query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){discussion(number:$num){id title body url category{name} comments(first:30){nodes{author{login} body}}}}}`
      try {
        return ghGraphql(q, { owner, repo, num: Number(n) })
      } catch (e) {
        return `(error fetching discussion: ${e.message})`
      }
    },
  }

  const gh_discussion_comment = {
    def: {
      name: 'gh_discussion_comment',
      description: 'Post a markdown comment on a discussion. Requires the discussion node id (provided by the workflow).',
      input_schema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string', description: 'Markdown comment body' },
          discussionId: { type: 'string', description: 'Discussion node id (default: current)' },
        },
      },
    },
    impl: ({ body, discussionId } = {}) => {
      const id = discussionId ?? discussionNodeId
      if (!body) return '(no body)'
      if (!id) return '(no discussion node id)'
      if (dryRun) {
        console.log(`\n[dry-run] Would comment on discussion ${id}:\n---\n${body}\n---`)
        return 'dry-run: discussion comment not posted'
      }
      const m = `mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{url}}}`
      try {
        const out = ghGraphql(m, { id, body })
        return `Discussion comment posted. ${out}`
      } catch (e) {
        return `(error posting discussion comment: ${e.message})`
      }
    },
  }

  // ---- GitHub Wiki (separate <repo>.wiki.git) ----

  const gh_wiki = {
    def: {
      name: 'gh_wiki',
      description: 'Read, list, or write the repository wiki (a separate git repo). To edit a page: read it, then write the COMPLETE new content.',
      input_schema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['read', 'list', 'write'] },
          page: { type: 'string', description: 'Page name without .md, e.g. "Home" or "Getting-Started"' },
          content: { type: 'string', description: 'Complete page markdown (write only)' },
          message: { type: 'string', description: 'Commit message (write only)' },
        },
      },
    },
    impl: ({ action, page, content, message }) => {
      const { owner, repo } = ownerRepo()
      const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
      if (!owner || !repo) return '(GITHUB_REPOSITORY not set)'
      const url = token
        ? `https://x-access-token:${token}@github.com/${owner}/${repo}.wiki.git`
        : `https://github.com/${owner}/${repo}.wiki.git`
      let dir
      try {
        dir = mkdtempSync(join(tmpdir(), 'wiki-'))
        execSync(`git clone --depth 1 ${url} ${dir}`, { stdio: 'pipe' })
      } catch (e) {
        return `(could not clone wiki — is it enabled? ${e.message})`
      }
      try {
        if (action === 'list') {
          return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).join('\n') || '(empty wiki)'
        }
        if (action === 'read') {
          if (!page) return '(no page)'
          const p = join(dir, `${page}.md`)
          return existsSync(p) ? readFileSync(p, 'utf8') : `(page not found: ${page})`
        }
        if (action === 'write') {
          if (!page || content === undefined) return '(write needs page and content)'
          if (dryRun) return `[dry-run] would write wiki page ${page} (${content.length} chars)`
          writeFileSync(join(dir, `${page}.md`), content, 'utf8')
          execSync('git config user.name "github-actions[bot]"', { cwd: dir })
          execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { cwd: dir })
          execSync('git add -A', { cwd: dir })
          if (run('git diff --cached --name-only', { cwd: dir }) === '') return '(no change to wiki page)'
          execFileSync('git', ['commit', '-m', message ?? `wiki: update ${page}`], { cwd: dir, stdio: 'pipe' })
          execSync('git push', { cwd: dir, stdio: 'pipe' })
          return `Wiki page "${page}" updated.`
        }
        return `(unknown action: ${action})`
      } catch (e) {
        return `(wiki ${action} error: ${e.message})`
      }
    },
  }

  return {
    git_diff, git_log, grep_repo, read_file, list_dir, list_changed_packages,
    write_file, edit_file, run_command, write_changeset,
    gh_get_pr, gh_get_issue, get_review, gh_list_labels,
    gh_pr_comment, gh_pr_review, gh_open_pr, gh_label,
    gh_get_discussion, gh_discussion_comment, gh_wiki,
  }
}

/** Curated tool groups, referenced by name from command configs. */
export const TOOL_GROUPS = {
  read: ['git_diff', 'git_log', 'grep_repo', 'read_file', 'list_dir', 'list_changed_packages', 'gh_get_pr'],
  review: ['write_changeset', 'gh_pr_review', 'gh_pr_comment'],
  fix: ['write_file', 'edit_file', 'run_command', 'get_review', 'gh_pr_comment'],
  pr: ['write_file', 'edit_file', 'run_command', 'write_changeset', 'gh_open_pr', 'gh_get_issue', 'gh_pr_comment'],
  explain: ['gh_pr_comment'],
  triage: ['gh_get_issue', 'gh_list_labels', 'gh_label', 'gh_pr_comment'],
  discussion: ['gh_get_discussion', 'gh_discussion_comment'],
  wiki: ['gh_wiki'],
}

/** Expand a list of tool names and/or @group references into a flat name list. */
export function expandToolNames(names) {
  const out = new Set()
  for (const n of names) {
    if (n.startsWith('@')) {
      const group = TOOL_GROUPS[n.slice(1)] ?? []
      group.forEach((t) => out.add(t))
    } else {
      out.add(n)
    }
  }
  return [...out]
}

/**
 * Assemble a toolset from a list of tool names and/or @group refs.
 * @returns {{ defs, impls }}
 */
export function buildToolset(names, ctx = {}) {
  const all = allTools(ctx)
  const flat = expandToolNames(names)
  const defs = []
  const impls = {}
  for (const n of flat) {
    if (!all[n]) {
      console.warn(`[tools] unknown tool: ${n}`)
      continue
    }
    defs.push(all[n].def)
    impls[n] = all[n].impl
  }
  return { defs, impls }
}

export { ALLOWED_COMMANDS }
