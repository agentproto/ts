import { appendFileSync, readFileSync } from 'node:fs'

export function parsePresetList(value) {
  return String(value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

export function resolveAgentAction(config, actionName, env = process.env, forceBackend = '') {
  const action = config.agentActions?.[actionName]
  if (!action) throw new Error(`unknown agent action: ${actionName}`)

  const requested = parsePresetList(env[action.env])
  let names = requested.length ? requested : action.presets
  if (!Array.isArray(names) || names.length === 0) throw new Error(`agent action ${actionName} has no presets`)

  if (forceBackend === 'claude-cloud') {
    const cloud = Object.entries(config.agentPresets || {}).find(([, preset]) => preset.cloud === 'anthropic' || preset.reviewerAdapter === 'claude-code-cloud')
    if (!cloud) throw new Error('no claude-cloud preset is configured')
    names = [cloud[0]]
  }
  if (forceBackend === 'opencode-free') {
    const free = names.filter((name) => config.agentPresets?.[name]?.reviewerAdapter === 'opencode')
    names = free.length ? free : action.presets.filter((name) => config.agentPresets?.[name]?.reviewerAdapter === 'opencode')
  }

  const presets = names.map((name) => {
    const preset = config.agentPresets?.[name]
    if (!preset) throw new Error(`agent action ${actionName} references unknown preset: ${name}`)
    return { name, ...preset }
  })
  return { action: actionName, env: action.env, names, presets }
}

export function toReviewConfig(config, resolved) {
  const [primary, ...fallbacks] = resolved.presets
  return {
    ...config,
    ...primary,
    reviewerFallbackModels: fallbacks
      .filter((preset) => preset.reviewerAdapter === primary.reviewerAdapter)
      .map((preset) => preset.reviewerModel)
      .filter(Boolean),
    resolvedAgentAction: {
      action: resolved.action,
      env: resolved.env,
      presets: resolved.names,
    },
  }
}

export function githubOutputs(resolved) {
  const primary = resolved.presets[0] || {}
  const fallback = resolved.presets[1] || {}
  return {
    names: resolved.names.join(','),
    backend: primary.cloud === 'anthropic' || primary.reviewerAdapter === 'claude-code-cloud' ? 'claude-cloud' : 'opencode-free',
    primary_name: primary.name || '',
    primary_adapter: primary.reviewerAdapter || '',
    primary_model: primary.reviewerModel || '',
    fallback_name: fallback.name || '',
    fallback_adapter: fallback.reviewerAdapter || '',
    fallback_model: fallback.reviewerModel || '',
  }
}

export function appendGithubOutputs(path, outputs) {
  for (const [key, value] of Object.entries(outputs)) appendFileSync(path, `${key}=${value}\n`)
}

export function readAgentConfig(path = '.github/agentic-review.json') {
  return JSON.parse(readFileSync(path, 'utf8'))
}
