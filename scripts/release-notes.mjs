#!/usr/bin/env node
/**
 * Agentic release notes generator.
 *
 * Triggered after `changesets/action` publishes packages. Reads the
 * per-package CHANGELOGs, greps the codebase for context, and composes
 * a consolidated human-readable release announcement — then posts it as
 * the body of the highest-bumped package's GitHub Release.
 *
 * Usage:
 *   node scripts/release-notes.mjs               # auto-detect published packages
 *   node scripts/release-notes.mjs --dry-run     # print to stdout, don't post
 *
 * Env:
 *   ANTHROPIC_API_KEY  — required
 *   GITHUB_TOKEN       — required for posting (not needed with --dry-run)
 *
 * Exit codes:
 *   0 — notes posted (or dry-run complete)
 *   1 — error
 */

import { execSync, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── root ──────────────────────────────────────────────────────────────────────

function findGitRoot(start) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd: start, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return null
  }
}
const ROOT =
  findGitRoot(process.cwd()) ??
  findGitRoot(new URL('..', import.meta.url).pathname) ??
  new URL('..', import.meta.url).pathname.replace(/\/$/, '')

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')

// ── helpers ───────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
  } catch {
    return ''
  }
}

// ── tool implementations ──────────────────────────────────────────────────────

/**
 * Discover packages published in the latest release commit.
 * `changesets/action` commits with "chore(release): version packages",
 * so we look at what changed in the most recent such commit.
 */
function tool_list_published_packages() {
  // Find the latest version-bump commit from changesets/action
  const releaseCommit = run(`git log --oneline --grep="chore(release): version packages" -1`)
  if (!releaseCommit) {
    // Fallback: find all @agentproto packages that have a CHANGELOG with a recent entry
    const pkgJsonPaths = run(
      'find packages adapters -maxdepth 3 -name "package.json" -not -path "*/node_modules/*"'
    ).split('\n').filter(Boolean)

    const published = []
    for (const p of pkgJsonPaths) {
      try {
        const { name, version, private: priv } = JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
        if (!name?.startsWith('@agentproto/') || priv) continue
        const changelogPath = p.replace('package.json', 'CHANGELOG.md')
        if (existsSync(resolve(ROOT, changelogPath))) {
          published.push({ name, version, changelogPath })
        }
      } catch {}
    }
    return JSON.stringify(published, null, 2)
  }

  // Parse the commit hash and inspect changed CHANGELOG files
  const commitHash = releaseCommit.split(' ')[0]
  const changedFiles = run(`git diff-tree --no-commit-id -r --name-only ${commitHash}`).split('\n').filter(Boolean)
  const changelogs = changedFiles.filter((f) => f.endsWith('CHANGELOG.md'))

  const published = []
  for (const changelogPath of changelogs) {
    const pkgJsonPath = changelogPath.replace('CHANGELOG.md', 'package.json')
    try {
      const { name, version, private: priv } = JSON.parse(readFileSync(resolve(ROOT, pkgJsonPath), 'utf8'))
      if (!name?.startsWith('@agentproto/') || priv) continue
      published.push({ name, version, changelogPath })
    } catch {}
  }
  return published.length > 0
    ? JSON.stringify(published, null, 2)
    : '(no packages published in latest release commit — try after `changeset version` is merged)'
}

function tool_read_changelog({ name, maxChars = 6_000 }) {
  if (!name) return '(no package name provided)'
  // Find the package dir
  const pkgJsonPaths = run(
    'find packages adapters -maxdepth 3 -name "package.json" -not -path "*/node_modules/*"'
  ).split('\n').filter(Boolean)

  for (const p of pkgJsonPaths) {
    try {
      const { name: pkgName } = JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
      if (pkgName !== name) continue
      const changelogPath = resolve(ROOT, p.replace('package.json', 'CHANGELOG.md'))
      if (!existsSync(changelogPath)) return `(no CHANGELOG.md found for ${name})`
      const content = readFileSync(changelogPath, 'utf8')
      // Return only the latest version block (up to maxChars)
      const trimmed = content.length > maxChars ? content.slice(0, maxChars) + '\n... (truncated)' : content
      return trimmed
    } catch {}
  }
  return `(package not found: ${name})`
}

function tool_read_file({ path }) {
  if (!path) return '(no path)'
  const abs = resolve(ROOT, path)
  if (!existsSync(abs)) return `(file not found: ${path})`
  try {
    const content = readFileSync(abs, 'utf8')
    return content.length > 8_000 ? content.slice(0, 8_000) + '\n... (truncated)' : content
  } catch {
    return `(could not read: ${path})`
  }
}

function tool_grep_repo({ pattern, glob = '' }) {
  if (!pattern) return '(no pattern)'
  try {
    const result = execSync(
      `grep -rn --include="*.ts" --include="*.mjs" --include="*.md" -m 5 ${JSON.stringify(pattern)} packages/ adapters/ 2>/dev/null | head -40`,
      { cwd: ROOT, encoding: 'utf8' }
    ).trim()
    return result || '(no matches)'
  } catch {
    return '(no matches)'
  }
}

function tool_list_git_tags() {
  return run('git tag --sort=-version:refname | grep "^@agentproto" | head -20') || '(no tags)'
}

function tool_post_release_notes({ tag, body }) {
  if (!tag || !body) return '(tag and body are required)'
  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] Would update GitHub Release ${tag}:\n---\n${body}\n---`)
    return `dry-run: release notes not posted for ${tag}`
  }
  try {
    // Update the existing GitHub Release created by changesets/action
    execFileSync('gh', ['release', 'edit', tag, '--notes', body], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
    })
    return `✓ Updated GitHub Release ${tag}`
  } catch {
    // Release might not exist yet — create it
    try {
      execFileSync('gh', ['release', 'create', tag, '--notes', body, '--title', tag], {
        cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
      })
      return `✓ Created GitHub Release ${tag}`
    } catch (e) {
      return `Error posting release notes: ${e.message}`
    }
  }
}

function tool_post_consolidated_release({ title, body, tag }) {
  // Posts a single consolidated GitHub Release for the whole release batch,
  // tagged as e.g. "release/2026-06-20" or uses the provided tag.
  const releaseTag = tag ?? `release/${new Date().toISOString().slice(0, 10)}`
  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] Would create consolidated release "${title}" (${releaseTag}):\n---\n${body}\n---`)
    return `dry-run: consolidated release not posted (tag: ${releaseTag})`
  }
  try {
    execFileSync('gh', ['release', 'create', releaseTag, '--title', title, '--notes', body, '--latest=false'], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
    })
    return `✓ Created consolidated GitHub Release: ${releaseTag}`
  } catch (e) {
    // If tag already exists, update it
    try {
      execFileSync('gh', ['release', 'edit', releaseTag, '--title', title, '--notes', body], {
        cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
      })
      return `✓ Updated consolidated GitHub Release: ${releaseTag}`
    } catch (e2) {
      return `Error: ${e2.message}`
    }
  }
}

// ── tool dispatch ─────────────────────────────────────────────────────────────

const TOOLS = {
  list_published_packages: tool_list_published_packages,
  read_changelog: tool_read_changelog,
  read_file: tool_read_file,
  grep_repo: tool_grep_repo,
  list_git_tags: tool_list_git_tags,
  post_release_notes: tool_post_release_notes,
  post_consolidated_release: tool_post_consolidated_release,
}

const TOOL_DEFS = [
  {
    name: 'list_published_packages',
    description: 'List @agentproto/* packages that were just published in the latest release, with their versions and CHANGELOG paths.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_changelog',
    description: 'Read the CHANGELOG.md for a specific @agentproto package (latest version block first).',
    input_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: '@agentproto/package-name' },
        maxChars: { type: 'number', description: 'Truncate at this many chars (default: 6000)' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read any file in the repo relative to the repo root.',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
      },
    },
  },
  {
    name: 'grep_repo',
    description: 'Search the codebase for a pattern across .ts, .mjs, .md files.',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        glob: { type: 'string' },
      },
    },
  },
  {
    name: 'list_git_tags',
    description: 'List recent @agentproto git tags (for version context).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'post_release_notes',
    description: 'Update the body of an existing per-package GitHub Release (created by changesets/action).',
    input_schema: {
      type: 'object',
      required: ['tag', 'body'],
      properties: {
        tag: { type: 'string', description: 'GitHub Release tag, e.g. "@agentproto/agent@0.2.0"' },
        body: { type: 'string', description: 'Markdown release notes body' },
      },
    },
  },
  {
    name: 'post_consolidated_release',
    description: 'Create (or update) a single consolidated GitHub Release that summarises the whole batch of package publishes.',
    input_schema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: 'Release title, e.g. "agentproto — June 2026 release"' },
        body: { type: 'string', description: 'Full markdown announcement' },
        tag: { type: 'string', description: 'Git tag for the release (default: release/YYYY-MM-DD)' },
      },
    },
  },
]

// ── system prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a technical writer and developer advocate for the @agentproto open-standards project.

Your job: compose a **consolidated, human-readable release announcement** for the latest batch of @agentproto package publishes.

## Workflow

1. Call \`list_published_packages\` to see what was released and at which version.
2. Call \`read_changelog\` for each published package to read the per-package CHANGELOG entries.
3. Use \`read_file\` and \`grep_repo\` **freely** to understand the actual code behind each change — don't just paraphrase the CHANGELOG, dig into what was built and why it matters.
4. Call \`list_git_tags\` for version context.
5. Write the announcement (see format below), then call \`post_consolidated_release\` to publish it.

## Release announcement format

\`\`\`markdown
# agentproto — [Month Year] release

> [One-sentence hook about the most significant thing in this release]

## What's new

### [Feature name] ([package]@[version])
[2-4 sentences explaining what it is, why it matters, and how to use it. Concrete — show the type signature or a short code example if it helps.]

### [Next feature] (...)
...

## Package versions

| Package | Version | Bump |
|---|---|---|
| `@agentproto/agent` | `0.2.0` | minor |
| ... | | |

## Installing / upgrading

\`\`\`bash
npm install @agentproto/agent@latest @agentproto/mcp-server@latest ...
\`\`\`

## Full changelogs
[Links to each package's CHANGELOG.md on GitHub]
\`\`\`

## Tone
- Technical but accessible. Assume the reader knows TypeScript and agents.
- Lead with the user benefit, not the implementation detail.
- Short paragraphs. Concrete examples > abstract descriptions.
- No hype words ("revolutionary", "powerful", "amazing").
- Use the imperative for feature names: "Add extends-chain validation", not "Extends-chain validation was added".
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

async function runAgenticLoop() {
  console.log(`\n📦 Release notes generator starting${DRY_RUN ? ' (dry-run)' : ''}…`)

  const messages = [
    {
      role: 'user',
      content: `Please generate release notes for the latest @agentproto package publishes.

Start by calling list_published_packages to see what was released, then read the CHANGELOGs and dig into the actual code to understand each change. Then compose a consolidated announcement and post it with post_consolidated_release.`,
    },
  ]

  let iterations = 0
  const MAX_ITER = 25

  while (iterations < MAX_ITER) {
    iterations++
    console.log(`\n⟳  Turn ${iterations}`)

    const resp = await callClaude(messages)
    messages.push({ role: 'assistant', content: resp.content })

    const toolUses = resp.content.filter((b) => b.type === 'tool_use')

    if (toolUses.length === 0) {
      const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
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

  if (iterations >= MAX_ITER) {
    console.warn(`\n⚠️  Reached max iterations (${MAX_ITER}) — stopping.`)
  }

  console.log('\n✅ Release notes complete.')
}

await runAgenticLoop()
