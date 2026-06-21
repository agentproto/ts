/**
 * agentflow LLM engine router — one call surface, two backends.
 *
 *   engine "local"  → spawn the Claude Code CLI (`claude -p`). Uses the
 *                     developer's subscription; no API key needed. This is
 *                     the default for local hooks.
 *   engine "cloud"  → POST api.anthropic.com (needs ANTHROPIC_API_KEY).
 *                     Used in CI and as a no-CLI fallback.
 *
 * Both return the model's raw text. Callers that expect JSON should strip
 * code fences (see `stripFences`) before parsing.
 */

import { spawnSync } from 'node:child_process'

const DEFAULT_CLOUD_MODEL = 'claude-haiku-4-5-20251001'

/** Strip ```json … ``` / ``` … ``` fences a CLI model may wrap output in. */
export function stripFences(text) {
  const t = text.trim()
  const m = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
  return (m ? m[1] : t).trim()
}

export async function runLlm({ system, user, engine = 'local', model, claudeBin = 'claude' }) {
  return engine === 'cloud'
    ? runCloud({ system, user, model })
    : runLocal({ system, user, model, claudeBin })
}

function runLocal({ system, user, model, claudeBin = 'claude' }) {
  // The CLI has no separate system slot in print mode, so prepend it.
  const prompt = `${system}\n\n--- INPUT ---\n${user}`
  const args = ['-p', prompt]
  if (model) args.push('--model', model)
  const res = spawnSync(claudeBin, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (res.error) {
    throw new Error(
      `[agentflow] local engine: cannot spawn "${claudeBin}" ` +
        `(${res.error.message}). Install the Claude Code CLI or set ` +
        `engine "cloud" in .agentflow.local.json.`,
    )
  }
  if (res.status !== 0) {
    throw new Error(
      `[agentflow] local engine: ${claudeBin} exited ${res.status}: ${res.stderr?.trim() || '(no stderr)'}`,
    )
  }
  return res.stdout.trim()
}

async function runCloud({ system, user, model = DEFAULT_CLOUD_MODEL }) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('[agentflow] cloud engine: ANTHROPIC_API_KEY is not set.')
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!response.ok) {
    throw new Error(`[agentflow] cloud engine: API error ${response.status}: ${await response.text()}`)
  }
  const data = await response.json()
  return (data.content?.[0]?.text ?? '').trim()
}
