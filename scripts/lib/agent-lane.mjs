/**
 * Billing lanes for the release-time agent scripts (release-notes, docs-check).
 *
 * One credential outage should never leave a release without notes: 2026-09-01
 * had two Anthropic orgs and a Moonshot account all run dry within an hour,
 * and every agentic post-release step died on its first API call. The CI
 * review job already survives that with a ladder (subscription OAuth token →
 * fallback OAuth token → API key). This module gives the plain-node scripts the
 * same ladder — they each pick ONE lane per invocation (`AGENT_LANE`), and the
 * workflow walks the lanes in order until the step's success gate is met.
 *
 * A lane is a complete, self-consistent env for the Claude Agent SDK:
 *   - `subscription`          CLAUDE_CODE_OAUTH_TOKEN (claude.ai plan, no per-token bill)
 *   - `subscription-fallback` CLAUDE_CODE_OAUTH_TOKEN_FALLBACK, same shape
 *   - `openrouter`            OPENROUTER_API_KEY via OpenRouter's Anthropic-compatible
 *                             Messages endpoint (gateway spawn: base_url + bearer)
 *   - `moonshot`              MOONSHOT_API_KEY via Moonshot's Anthropic-compatible gateway
 *   - `api-key`               ANTHROPIC_API_KEY, native Anthropic billing
 *
 * Every lane SCRUBS the credentials of the other lanes from the env it hands
 * to the SDK, so a stale ANTHROPIC_API_KEY on the runner can never out-rank the
 * lane that was asked for (the claude CLI prefers an API key over an OAuth
 * token when both are present, and a gateway 401s on a native key).
 */

export const LANES = ['subscription', 'subscription-fallback', 'openrouter', 'moonshot', 'api-key']

/** Default walk order when `AGENT_LANE` is unset: cheapest-for-us first. */
export const AUTO_ORDER = ['subscription', 'subscription-fallback', 'openrouter', 'api-key', 'moonshot']

export const OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'
export const MOONSHOT_ANTHROPIC_BASE_URL = 'https://api.moonshot.ai/anthropic'

export const DEFAULT_MODELS = {
  subscription: 'claude-sonnet-4-6',
  'subscription-fallback': 'claude-sonnet-4-6',
  openrouter: 'anthropic/claude-sonnet-4.6',
  moonshot: 'kimi-k2.7-code',
  'api-key': 'claude-sonnet-4-6',
}

/** Env toggles that would redirect the CLI to a cloud provider (Bedrock, Vertex,
 *  …) and out-rank ANTHROPIC_BASE_URL. Always scrubbed. */
export const CLOUD_PROVIDER_REDIRECT_TOGGLES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
]

/** Every credential / routing var any lane could set. Scrubbed before a lane
 *  writes its own, so lanes never bleed into each other. */
const LANE_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
]

const CREDENTIAL_FOR = {
  subscription: ['CLAUDE_CODE_OAUTH_TOKEN'],
  'subscription-fallback': ['CLAUDE_CODE_OAUTH_TOKEN_FALLBACK'],
  openrouter: ['OPENROUTER_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  'api-key': ['ANTHROPIC_API_KEY'],
}

const firstPresent = (env, names) => names.find((n) => typeof env[n] === 'string' && env[n].length > 0)

/** Whether `env` carries the credential lane `name` needs. */
export function laneAvailable(name, env = process.env) {
  return Boolean(CREDENTIAL_FOR[name] && firstPresent(env, CREDENTIAL_FOR[name]))
}

/**
 * Pick the lane for this invocation: `AGENT_LANE` when set (a CI ladder step
 * always sets it), else the first lane in AUTO_ORDER whose credential is
 * present, else null.
 */
export function pickLane(env = process.env) {
  const explicit = (env.AGENT_LANE ?? '').trim()
  if (explicit) {
    if (!LANES.includes(explicit)) throw new Error(`AGENT_LANE="${explicit}" is not one of: ${LANES.join(', ')}`)
    return explicit
  }
  return AUTO_ORDER.find((name) => laneAvailable(name, env)) ?? null
}

/**
 * Build the SDK env + model for a lane. Returns `{ lane, label, model, env,
 * thinking, missing }` — `missing` names the absent credential (and `env` is
 * null) when the lane cannot run; the caller decides whether that is fatal.
 * `env` is a fresh object: `base` is never mutated.
 */
export function resolveLane(name, base = process.env, { model } = {}) {
  if (!LANES.includes(name)) throw new Error(`unknown agent lane "${name}"`)
  const cred = firstPresent(base, CREDENTIAL_FOR[name])
  const chosenModel = model || base.AGENT_MODEL || DEFAULT_MODELS[name]
  const label = `${name} · ${chosenModel}`
  if (!cred) return { lane: name, label, model: chosenModel, env: null, thinking: false, missing: CREDENTIAL_FOR[name][0] }

  const env = { ...base }
  for (const k of [...LANE_VARS, ...CLOUD_PROVIDER_REDIRECT_TOGGLES]) delete env[k]
  delete env.AGENT_LANE

  const pinModel = () => {
    env.ANTHROPIC_MODEL = chosenModel
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = chosenModel
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = chosenModel
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = chosenModel
    env.ANTHROPIC_SMALL_FAST_MODEL = chosenModel
  }

  let thinking = false
  switch (name) {
    case 'subscription':
    case 'subscription-fallback':
      env.CLAUDE_CODE_OAUTH_TOKEN = base[cred]
      break
    case 'openrouter':
      env.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_BASE_URL
      env.ANTHROPIC_AUTH_TOKEN = base[cred]
      pinModel()
      break
    case 'moonshot':
      env.ANTHROPIC_BASE_URL = MOONSHOT_ANTHROPIC_BASE_URL
      env.ANTHROPIC_AUTH_TOKEN = base[cred]
      pinModel()
      // Kimi rejects a request without extended thinking enabled.
      thinking = true
      break
    case 'api-key':
      env.ANTHROPIC_API_KEY = base[cred]
      break
  }
  return { lane: name, label, model: chosenModel, env, thinking, missing: null }
}

/** Log-safe one-liner: lane + model, never a secret. */
export function describeLane(resolved) {
  return resolved.missing ? `${resolved.label} (unavailable: ${resolved.missing} not set)` : resolved.label
}
