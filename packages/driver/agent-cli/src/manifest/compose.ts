/**
 * Spawn-argument composer.
 *
 * Pure function: given an `AgentCliHandle` and a per-call
 * `RuntimeConfig`, produces the final `binArgs + env` to pass to the
 * runtime's `start()`. Validates the config against the manifest's
 * declared `modes` / `options` / `continuation.supported`; unknown ids
 * throw `RuntimeConfigError` (the host should NOT spawn — the user
 * configured something the manifest doesn't accept).
 *
 * Composition order (matches AIP-45 spec):
 *   1. Every declared `bin_args_prepend` (mode's, then each present
 *      option's in declaration order) — argv that must precede a
 *      subcommand baked into `bin_args` (e.g. hermes'
 *      `--ignore-user-config` ahead of `acp`).
 *   2. Manifest's default `bin_args` (from `handle.bin_args`).
 *   3. Every declared `bin_args_append` / `bin_args_append_when_true`
 *      / `bin_args_template` (mode's, then each present option's in
 *      declaration order).
 * Final argv is `[...prepend, ...bin_args, ...append]`.
 *
 * Mode is applied before options because modes are coarse profile
 * switches (claude-code's `--permission-mode`) — options refine them.
 * Within options, declaration order is honoured so adapter authors
 * can express "this flag must come after that one" without the host
 * needing to know the rule.
 */

import type {
  AgentCliHandle,
  AgentCliOption,
  RuntimeConfig,
} from "../types.js"

/**
 * Thrown when `RuntimeConfig` references manifest entries that don't
 * exist or violates a declared constraint (type / enum / bounds). The
 * `code` field lets callers map to friendly UI messages without
 * inspecting the message string.
 */
export class RuntimeConfigError extends Error {
  readonly code:
    | "unknown_mode"
    | "unknown_option"
    | "option_type_mismatch"
    | "option_enum_violation"
    | "option_bounds_violation"
    | "unsupported_continuation"
  readonly path: string
  constructor(
    code: RuntimeConfigError["code"],
    path: string,
    message: string
  ) {
    super(`[${code} at ${path}] ${message}`)
    this.code = code
    this.path = path
    this.name = "RuntimeConfigError"
  }
}

/**
 * Resolved spawn args + env. The runtime's `start()` impl merges
 * `env` into the host process env / sandbox env before exec.
 */
export interface ComposedSpawn {
  binArgs: string[]
  env: Record<string, string>
}

/**
 * Compose the final spawn args from a manifest + per-call config.
 * Pure — no I/O, no sandbox access, no global state. Safe to call
 * repeatedly with the same input.
 *
 * `config` may be undefined or an empty object — both fall back to
 * the manifest's defaults verbatim (manifest `bin_args`, no mode
 * patch, no option patches). Continuation is not applied here — the
 * `ContinuationStrategy` registry handles that — but we DO validate
 * `config.continuation` against `manifest.continuation.supported` so
 * a misconfigured operator fails fast at compose time, not at the
 * point the strategy tries to acquire a session.
 */
export function composeSpawn(
  handle: AgentCliHandle,
  config?: RuntimeConfig
): ComposedSpawn {
  if (!config) return { binArgs: [...(handle.bin_args ?? [])], env: {} }

  const prepend: string[] = []
  const append: string[] = []
  const env: Record<string, string> = {}

  // ── Mode patch ──────────────────────────────────────────────────
  if (config.mode !== undefined) {
    const mode = (handle.modes ?? []).find(m => m.id === config.mode)
    if (!mode) {
      const known = (handle.modes ?? []).map(m => m.id).join(", ") || "(none)"
      throw new RuntimeConfigError(
        "unknown_mode",
        "config.mode",
        `Mode '${config.mode}' is not declared by manifest '${handle.id}'. Known modes: ${known}`
      )
    }
    if (mode.bin_args_prepend) prepend.push(...mode.bin_args_prepend)
    if (mode.bin_args_append) append.push(...mode.bin_args_append)
    if (mode.env) Object.assign(env, mode.env)
  }

  // ── Option patches (declaration order) ──────────────────────────
  if (config.options && Object.keys(config.options).length > 0) {
    const declared = handle.options ?? []
    const declaredById = new Map(declared.map(o => [o.id, o]))
    // Reject unknown ids first so the operator sees ALL the typos
    // (not just the one we hit first when iterating declared).
    for (const id of Object.keys(config.options)) {
      if (!declaredById.has(id)) {
        const known = declared.map(o => o.id).join(", ") || "(none)"
        throw new RuntimeConfigError(
          "unknown_option",
          `config.options.${id}`,
          `Option '${id}' is not declared by manifest '${handle.id}'. Known options: ${known}`
        )
      }
    }
    // Then apply patches in declaration order so adapter-author intent
    // wins over operator-config key order.
    for (const option of declared) {
      if (!(option.id in config.options)) continue
      const value = config.options[option.id] as boolean | number | string
      validateOptionValue(option, value)
      const patch = renderOptionPatch(option, value)
      prepend.push(...patch.prepend)
      append.push(...patch.append)
      Object.assign(env, patch.env)
    }
  }

  // ── Continuation validation (no patch — strategy registry owns) ─
  if (config.continuation !== undefined && handle.continuation) {
    if (!handle.continuation.supported.includes(config.continuation)) {
      throw new RuntimeConfigError(
        "unsupported_continuation",
        "config.continuation",
        `Continuation strategy '${config.continuation}' is not in manifest '${handle.id}'.continuation.supported (${handle.continuation.supported.join(", ")}).`
      )
    }
  }

  return {
    binArgs: [...prepend, ...(handle.bin_args ?? []), ...append],
    env,
  }
}

/**
 * Resolve the continuation strategy id to use for this call. Operator
 * config wins; manifest default is the fallback; "none" if neither
 * declares anything (preserves pre-AIP-45-extension behaviour).
 */
export function resolveContinuationStrategy(
  handle: AgentCliHandle,
  config?: RuntimeConfig
): import("../types.js").ContinuationStrategyId {
  if (config?.continuation) return config.continuation
  return handle.continuation?.default ?? "none"
}

function validateOptionValue(
  option: AgentCliOption,
  value: boolean | number | string
): void {
  const path = `config.options.${option.id}`
  switch (option.type) {
    case "boolean":
      if (typeof value !== "boolean") {
        throw new RuntimeConfigError(
          "option_type_mismatch",
          path,
          `Expected boolean, got ${typeof value} (${JSON.stringify(value)}).`
        )
      }
      return
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new RuntimeConfigError(
          "option_type_mismatch",
          path,
          `Expected integer, got ${typeof value === "number" ? "non-integer number" : typeof value} (${JSON.stringify(value)}).`
        )
      }
      if (option.min !== undefined && value < option.min) {
        throw new RuntimeConfigError(
          "option_bounds_violation",
          path,
          `Value ${value} is below the declared minimum ${option.min}.`
        )
      }
      if (option.max !== undefined && value > option.max) {
        throw new RuntimeConfigError(
          "option_bounds_violation",
          path,
          `Value ${value} is above the declared maximum ${option.max}.`
        )
      }
      return
    case "string":
      if (typeof value !== "string") {
        throw new RuntimeConfigError(
          "option_type_mismatch",
          path,
          `Expected string, got ${typeof value} (${JSON.stringify(value)}).`
        )
      }
      return
    case "enum":
      if (typeof value !== "string") {
        throw new RuntimeConfigError(
          "option_type_mismatch",
          path,
          `Expected string (enum value), got ${typeof value} (${JSON.stringify(value)}).`
        )
      }
      if (!(option.enum ?? []).includes(value)) {
        throw new RuntimeConfigError(
          "option_enum_violation",
          path,
          `Value '${value}' is not in the declared enum (${(option.enum ?? []).join(", ")}).`
        )
      }
      return
  }
}

function renderOptionPatch(
  option: AgentCliOption,
  value: boolean | number | string
): { prepend: string[]; append: string[]; env: Record<string, string> } {
  const stringValue = String(value)

  // boolean type: only emit the bare flag when value === true and the
  // option declared `bin_args_append_when_true`. Honor `env` too —
  // adapter authors might want to surface the bool via env. Booleans
  // have no prepend counterpart — `bin_args_append_when_true` is for
  // bare flags, which never need to precede a baked-in subcommand.
  if (option.type === "boolean") {
    if (value !== true) return { prepend: [], append: [], env: {} }
    return {
      prepend: [],
      append: option.bin_args_append_when_true
        ? [...option.bin_args_append_when_true]
        : [],
      env: option.env ? interpolateEnv(option.env, stringValue) : {},
    }
  }

  // value-bearing types — apply `bin_args_prepend` / `bin_args_template`
  // (with `{value}` interpolation) and merge `env`.
  return {
    prepend: option.bin_args_prepend
      ? option.bin_args_prepend.map(token =>
          token.replace(/\{value\}/g, stringValue)
        )
      : [],
    append: option.bin_args_template
      ? option.bin_args_template.map(token =>
          token.replace(/\{value\}/g, stringValue)
        )
      : [],
    env: option.env ? interpolateEnv(option.env, stringValue) : {},
  }
}

function interpolateEnv(
  env: Record<string, string>,
  value: string
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\{value\}/g, value)
  }
  return out
}
