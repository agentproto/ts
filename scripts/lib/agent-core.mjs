#!/usr/bin/env node
/**
 * Shared agentic core for the @agentproto/ts review + command harness.
 *
 * One Anthropic tool-use loop, one config loader, one skills loader —
 * reused by review-pr.mjs (auto-review), apply-review.mjs (auto-fix),
 * and agent-command.mjs (on-demand slash/@mention commands).
 *
 * No runtime deps: raw fetch against the Messages API, Node 22 built-ins only.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// ── repo root ───────────────────────────────────────────────────────────────
// Primary: the caller's git repo (so the harness operates on the checked-out
// PR branch even when invoked from another worktree). Fallback: this file's
// own repo two levels up (scripts/lib/ → repo root).

export function findGitRoot(start) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: start, encoding: 'utf8', stdio: 'pipe',
    }).trim()
  } catch {
    return null
  }
}

export const ROOT =
  findGitRoot(process.cwd()) ??
  findGitRoot(new URL('../..', import.meta.url).pathname) ??
  new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

// ── shell helper ────────────────────────────────────────────────────────────

export function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
  } catch {
    return ''
  }
}

// ── config ──────────────────────────────────────────────────────────────────

export const CONFIG_DEFAULTS = {
  /** When true + reviewDecision is CHANGES_REQUESTED, the merge gate fails. */
  blocking: true,
  /** Anthropic model id for all agent flows. */
  model: 'claude-sonnet-5',
  /** How the auto-fixer delivers changes: "commit" (push to PR branch) or
   *  "pr" (push to bot/fix-<pr> and open a stacked PR against the PR branch). */
  fixDelivery: 'commit',
  /** In-repo skill names (resolved against .github/agent-skills/<name>.md) or
   *  allow-listed external refs (owner/repo@skill). Loaded into every flow's
   *  system prompt by default; per-command overrides may narrow this. */
  skills: [],
  /** External skill fetching is gated to this allow-list (owner/repo@skill). */
  externalSkills: { allow: [] },
  /** Mention string the command workflow matches in PR/issue comments, in
   *  addition to slash-commands. Must equal the installed App's @-handle. */
  botMention: '@agentproto-bot',
  /** Max consecutive auto-fix iterations before escalating to a human. */
  maxFixIterations: 3,
  /** Max agent-loop turns the PR reviewer may take before it is force-stopped.
   *  The reviewer MUST post its review before this cap (review-pr.mjs fails the
   *  gate if it doesn't), so this is headroom, not a target. Overridable
   *  per-command via commands.review.maxReviewTurns. */
  maxReviewTurns: 50,
  /** `max_tokens` for every Messages API call in the agent loop. Must comfortably
   *  fit the LARGEST single assistant turn a flow produces — for the reviewer
   *  that is the whole `gh_pr_review` body, which blew through the old 4096 cap
   *  on PR #1297 and truncated the mandatory review call into nothing. */
  maxResponseTokens: 16_384,
  /** Per-command overrides: { review: { model?, skills?, ... }, fix: {...} }. */
  commands: {},
}

export function loadConfig() {
  const path = resolve(ROOT, '.github/agentic-review.json')
  if (!existsSync(path)) return { ...CONFIG_DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      ...CONFIG_DEFAULTS,
      ...raw,
      externalSkills: { ...CONFIG_DEFAULTS.externalSkills, ...(raw.externalSkills ?? {}) },
      commands: { ...CONFIG_DEFAULTS.commands, ...(raw.commands ?? {}) },
    }
  } catch (e) {
    console.warn(`[agent-core] could not parse agentic-review.json: ${e.message} — using defaults`)
    return { ...CONFIG_DEFAULTS }
  }
}

/**
 * Resolve effective settings for a given command, layering:
 *   CONFIG_DEFAULTS  <  top-level config  <  config.commands[command]  <  overrides
 */
export function resolveCommandConfig(config, command, overrides = {}) {
  const base = { ...config }
  delete base.commands
  return { ...base, ...(config.commands?.[command] ?? {}), ...overrides }
}

// ── skills ──────────────────────────────────────────────────────────────────

/**
 * Load skill bodies for the given names. In-repo skills (.github/agent-skills/
 * <name>.md) win. A name shaped like "owner/repo@skill" that appears in the
 * external allow-list is fetched best-effort via `npx skills` and read from the
 * conventional install location; failures degrade to a skipped skill (logged).
 */
export function loadSkills(names = [], { allowExternal = [] } = {}) {
  const skillsDir = resolve(ROOT, '.github/agent-skills')
  const loaded = []
  for (const name of names) {
    const isExternalRef = name.includes('/') || name.includes('@')
    if (!isExternalRef) {
      const local = resolve(skillsDir, `${name}.md`)
      if (existsSync(local)) {
        loaded.push({ name, source: 'in-repo', body: readFileSync(local, 'utf8') })
      } else {
        console.warn(`[agent-core] skill not found in-repo: ${name}`)
      }
      continue
    }
    // External ref — only if allow-listed.
    if (!allowExternal.includes(name)) {
      console.warn(`[agent-core] external skill not allow-listed, skipping: ${name}`)
      continue
    }
    const body = fetchExternalSkill(name)
    if (body) loaded.push({ name, source: 'external', body })
  }
  return loaded
}

function fetchExternalSkill(ref) {
  // ref: owner/repo@skill — install globally, then read the SKILL.md.
  try {
    execSync(`npx --yes skills add ${ref} -g -y`, { cwd: ROOT, stdio: 'pipe', timeout: 60_000 })
  } catch (e) {
    console.warn(`[agent-core] npx skills add ${ref} failed: ${e.message}`)
    return null
  }
  const skill = ref.split('@').pop()
  const candidates = [
    resolve(process.env.HOME ?? '', `.claude/skills/${skill}/SKILL.md`),
    resolve(process.env.HOME ?? '', `.config/skills/${skill}/SKILL.md`),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8')
  }
  // Last resort: scan the in-repo skills dir in case it installed there.
  try {
    const dir = resolve(ROOT, '.github/agent-skills')
    const hit = readdirSync(dir).find((f) => f === `${skill}.md`)
    if (hit) return readFileSync(resolve(dir, hit), 'utf8')
  } catch {}
  console.warn(`[agent-core] could not locate SKILL.md for ${ref} after install`)
  return null
}

export function renderSkillsBlock(skills) {
  if (!skills.length) return ''
  const blocks = skills.map(
    (s) => `### Skill: ${s.name} (${s.source})\n${s.body.trim()}`
  )
  return [
    '\n\n## Loaded skills',
    'Apply the following skills where relevant to this task.',
    ...blocks,
  ].join('\n\n')
}

// ── Anthropic client + agentic loop ──────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export async function callClaude({ apiKey, model, system, tools, messages, maxTokens = 4096 }) {
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, tools, messages }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Anthropic API ${response.status}: ${body}`)
  }
  return response.json()
}

/** Appended to the last user turn when a response came back truncated, so the
 *  retry knows WHY it is being re-asked and what to do differently. */
const TRUNCATION_NOTICE =
  '⚠️ Your previous response was cut off because it exceeded the per-response ' +
  'token limit, so none of it could be used. Redo that turn, but keep it SHORT: ' +
  'no preamble, no restating the diff, and if you were writing a long tool input ' +
  '(e.g. a review body) trim it to the essentials before emitting it.'

/**
 * Drive a tool-use loop until the model stops calling tools or maxTurns is hit.
 *
 * @returns {{ messages, finalText, turns, maxedOut }}
 */
export async function runAgentLoop({
  apiKey,
  model,
  system,
  tools,
  toolImpls,
  userPrompt,
  maxTokens = 4096,
  maxTurns = 24,
  // How many `stop_reason: "max_tokens"` responses to absorb (with a rewind +
  // "be terse" nudge) before giving up. Exhausting them THROWS rather than
  // returning a clean-looking empty result — see the rewind below.
  maxTruncationRetries = 2,
  onTurn,
  onToolCall,
  // Called once per API response with `{ turn, stopReason, toolNames, textChars }`.
  // The ONLY place `stop_reason` surfaces; without it a truncated turn is
  // indistinguishable from a finished one in the logs.
  onResponse,
  // When set, inject `wrapUpMessage` once, as a text block appended to the tool
  // results, as soon as `maxTurns - turn <= wrapUpMargin`. Gives a flow with a
  // mandatory final action (e.g. the reviewer must call gh_pr_review) a chance
  // to stop exploring and act before the turn budget runs out. No-op by default.
  wrapUpMargin = 0,
  wrapUpMessage = null,
}) {
  if (!apiKey) throw new Error('runAgentLoop: apiKey is required')
  const messages = [{ role: 'user', content: userPrompt }]
  let turn = 0
  let wrappedUp = false
  let truncations = 0

  while (turn < maxTurns) {
    turn++
    onTurn?.(turn)

    const resp = await callClaude({ apiKey, model, system, tools, messages, maxTokens })
    const toolUses = resp.content.filter((b) => b.type === 'tool_use')
    onResponse?.({
      turn,
      stopReason: resp.stop_reason ?? null,
      toolNames: toolUses.map((b) => b.name),
      textChars: resp.content
        .filter((b) => b.type === 'text')
        .reduce((n, b) => n + b.text.length, 0),
    })

    // A `max_tokens` stop means the turn is UNUSABLE, not finished: the model
    // was mid-sentence, or — worse — mid-`tool_use`, where the input JSON may
    // have been cut before it closed. Executing a half-parsed tool call could
    // post a mangled review; keeping the turn and falling through to the
    // "no tool uses ⇒ the model is done" branch below is how PR #1297's
    // reviewer exited clean having never called the mandatory `gh_pr_review`
    // (46s of generation, zero tool calls, empty finalText, exit 0 from the
    // loop's point of view). So: never trust it, rewind, re-ask tersely.
    if (resp.stop_reason === 'max_tokens') {
      truncations++
      if (truncations > maxTruncationRetries) {
        throw new Error(
          `runAgentLoop: response truncated by max_tokens (${maxTokens}) ` +
            `${truncations}× — raise maxTokens or shorten the flow's output. ` +
            'Refusing to return a partial result that would read as success.',
        )
      }
      // Drop the truncated assistant turn entirely and append the notice to the
      // preceding USER turn — re-asking the same question with an explicit
      // "you were cut off, be terse" rider. Pushing the partial turn instead
      // would leave a dangling tool_use with no tool_result (API error) or a
      // half-thought the model then tries to continue from.
      const last = messages[messages.length - 1]
      const notice = { type: 'text', text: TRUNCATION_NOTICE }
      if (typeof last.content === 'string') {
        last.content = [{ type: 'text', text: last.content }, notice]
      } else {
        last.content.push(notice)
      }
      continue
    }

    messages.push({ role: 'assistant', content: resp.content })

    if (toolUses.length === 0) {
      const finalText = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      return { messages, finalText, turns: turn, maxedOut: false }
    }

    const toolResults = []
    for (const use of toolUses) {
      const fn = toolImpls[use.name]
      let result
      if (!fn) {
        result = `(unknown tool: ${use.name})`
      } else {
        onToolCall?.(use.name, use.input ?? {})
        try {
          result = await fn(use.input ?? {})
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

    // Nudge the model to wrap up and take its mandatory final action while it
    // still has turns left. Injected once, after the tool_result blocks (which
    // must come first in the user turn).
    if (wrapUpMessage && !wrappedUp && maxTurns - turn <= wrapUpMargin) {
      toolResults.push({ type: 'text', text: wrapUpMessage })
      wrappedUp = true
    }

    messages.push({ role: 'user', content: toolResults })
    if (resp.stop_reason === 'end_turn') {
      return { messages, finalText: '', turns: turn, maxedOut: false }
    }
  }

  return { messages, finalText: '', turns: turn, maxedOut: true }
}
