/**
 * agentflow config — one composable place to toggle the local agentic
 * helpers (AI changeset, local review) and how they run.
 *
 * Two layers, deep-merged (later wins):
 *   .agentflow.json         committed team defaults (safe for everyone)
 *   .agentflow.local.json   per-dev opt-in overrides (gitignored)
 *
 * Each feature resolves two axes:
 *   stage:  "manual" | "commit" | "push"   — when the git hook runs it
 *   engine: "local"  | "cloud"             — local = Claude Code CLI
 *                                            (subscription); cloud = API
 *
 * Defaults are intentionally conservative: stage "manual" so a fresh
 * clone never blocks a commit/push on an AI call until a dev opts in via
 * .agentflow.local.json.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULTS = {
  changeset: { stage: 'manual', engine: 'local', model: null, command: 'claude' },
  review: {
    stage: 'manual',
    engine: 'local',
    bypassCi: false,
    blocking: false,
    fix: 'off',
    maxLoops: 3,
    model: null,
    command: 'claude',
    // engine "daemon": runs the SAME pr-review WORKFLOW.md CI runs, through
    // the developer's already-running local agentproto daemon over MCP.
    daemonPort: 18790,
    daemonTimeoutMinutes: 15,
    // Override .github/agentic-review.json's reviewerAdapter for the daemon
    // run; null keeps the file's value (a dev's daemon typically has
    // "claude-code").
    adapter: null,
  },
}

function readJson(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(`[agentflow] ignoring malformed ${path}: ${err.message}`)
    return {}
  }
}

/** Shallow-merge each top-level feature object (one level deep). */
function mergeLayer(base, override) {
  const out = { ...base }
  for (const key of Object.keys(override)) {
    out[key] =
      override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])
        ? { ...(base[key] ?? {}), ...override[key] }
        : override[key]
  }
  return out
}

export function loadAgentflowConfig(root) {
  const committed = readJson(resolve(root, '.agentflow.json'))
  const local = readJson(resolve(root, '.agentflow.local.json'))
  return mergeLayer(mergeLayer(DEFAULTS, committed), local)
}

/**
 * Resolve the engine for a feature with precedence:
 *   CLI flag (--engine) > env AGENTFLOW_ENGINE > config > default.
 * Returns "local" | "cloud" | "daemon". ("daemon" is currently only wired up
 * for the `review` feature — see scripts/agentflow/review.mjs.)
 */
export function resolveEngine(featureCfg, { flag, env = process.env } = {}) {
  const pick = flag || env.AGENTFLOW_ENGINE || featureCfg?.engine || 'local'
  if (pick !== 'local' && pick !== 'cloud' && pick !== 'daemon') {
    throw new Error(`[agentflow] invalid engine "${pick}" (want "local" | "cloud" | "daemon")`)
  }
  return pick
}
