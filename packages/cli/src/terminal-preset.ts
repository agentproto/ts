/**
 * Resolver for named terminal/TUI presets stored in
 * `~/.agentproto/config.json` under `terminalPresets`.
 *
 * Presets are intentionally local-only: they let a user keep a personal
 * launch recipe (argv, env, cwd, name/label) without polluting shared
 * adapter manifests or global defaults with proxy hosts or secrets.
 *
 * The CLI uses this module to:
 *   - validate the on-disk preset shape,
 *   - merge it with explicit `sessions terminal` flags (flags win),
 *   - produce a normalized payload ready for POST /sessions/terminal.
 */

import type {
  AgentprotoConfig,
  TerminalPreset,
} from "@agentproto/runtime/config"

export interface ResolvedTerminalPreset {
  argv?: string[]
  env?: Record<string, string>
  cwd?: string
  workspace?: string
  name?: string
  label?: string
}

export type TerminalPresetResolution =
  | { ok: true; preset: ResolvedTerminalPreset }
  | { ok: false; error: string }

export interface TerminalPresetCliValues {
  /** argv supplied explicitly after `--` (or legacy pre-`--` positionals). */
  argv?: string[]
  cwd?: string
  workspace?: string
  name?: string
  label?: string
}

/**
 * Resolve a named terminal preset against explicit CLI values.
 *
 * Precedence (lowest → highest):
 *   preset.argv      < explicit argv (non-empty)
 *   preset.cwd       < explicit --cwd
 *   preset.workspace < explicit --workspace
 *   preset.name      < explicit --name
 *   preset.label     < explicit --label
 *   env is preset-only; there is no CLI `--env` surface to override with.
 */
export function resolveTerminalPreset(
  name: string,
  config: AgentprotoConfig,
  cli: TerminalPresetCliValues,
): TerminalPresetResolution {
  const raw = config.terminalPresets?.[name]
  if (raw === undefined) {
    return {
      ok: false,
      error: `terminal preset "${name}" not found in ~/.agentproto/config.json.\n` +
        `  Define it under terminalPresets.${name} (see agentproto sessions --help).`,
    }
  }

  const validated = validateTerminalPreset(raw, name)
  if (validated.ok === false) return validated

  const preset = validated.preset
  const explicitArgv = cli.argv && cli.argv.length > 0 ? cli.argv : undefined
  return {
    ok: true,
    preset: {
      argv: explicitArgv ?? preset.argv,
      env: preset.env,
      cwd: cli.cwd ?? preset.cwd,
      workspace: cli.workspace ?? preset.workspace,
      name: cli.name ?? preset.name,
      label: cli.label ?? preset.label,
    },
  }
}

/**
 * Validate and normalize a single raw preset value. Returns a sanitized
 * copy so downstream code never sees unexpected types.
 */
export function validateTerminalPreset(
  raw: TerminalPreset,
  name: string,
): TerminalPresetResolution {
  const out: ResolvedTerminalPreset = {}

  if (raw.argv !== undefined) {
    if (!Array.isArray(raw.argv) || raw.argv.length === 0) {
      return {
        ok: false,
        error: `terminal preset "${name}" has an invalid argv (expected a non-empty array of strings).`,
      }
    }
    const argv: string[] = []
    for (const item of raw.argv) {
      if (typeof item !== "string" || item.length === 0) {
        return {
          ok: false,
          error: `terminal preset "${name}" argv must be non-empty strings.`,
        }
      }
      argv.push(item)
    }
    out.argv = argv
  }

  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      return {
        ok: false,
        error: `terminal preset "${name}" env must be an object of string keys → string values.`,
      }
    }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== "string") {
        return {
          ok: false,
          error: `terminal preset "${name}" env value for "${key}" must be a string.`,
        }
      }
      env[key] = value
    }
    if (Object.keys(env).length > 0) {
      out.env = env
    }
  }

  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string" || raw.cwd.length === 0) {
      return {
        ok: false,
        error: `terminal preset "${name}" cwd must be a non-empty string.`,
      }
    }
    out.cwd = raw.cwd
  }

  if (raw.workspace !== undefined) {
    if (typeof raw.workspace !== "string" || raw.workspace.length === 0) {
      return {
        ok: false,
        error: `terminal preset "${name}" workspace must be a non-empty string.`,
      }
    }
    out.workspace = raw.workspace
  }

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      return {
        ok: false,
        error: `terminal preset "${name}" name must be a non-empty string.`,
      }
    }
    out.name = raw.name
  }

  if (raw.label !== undefined) {
    if (typeof raw.label !== "string" || raw.label.length === 0) {
      return {
        ok: false,
        error: `terminal preset "${name}" label must be a non-empty string.`,
      }
    }
    out.label = raw.label
  }

  return { ok: true, preset: out }
}
