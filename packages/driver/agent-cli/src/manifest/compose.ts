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
    | "model_denied"
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
  /**
   * Env keys the active mode AND active options declared for deletion
   * (AgentCliMode.env_unset / AgentCliOption.env_unset). Surfaced
   * pure-side so the runtime's `start()` — which owns the process.env
   * merge — can apply the deletions at the one point where the ambient
   * env is actually present (compose starts from `{}` and can't delete
   * what isn't there yet). Empty when nothing declares any.
   */
  envUnset: string[]
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
  if (!config)
    return {
      binArgs: [...(handle.bin_args ?? [])],
      env: { ...(handle.env ?? {}) },
      envUnset: [],
    }

  const prepend: string[] = []
  const append: string[] = []
  // Always-on manifest env goes in first so a selected mode/option can
  // still override any key it also declares (mode/option intent wins).
  const env: Record<string, string> = { ...(handle.env ?? {}) }
  const envUnset: string[] = []

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
    // "config" modes have no argv/env surface — the CLI doesn't accept a
    // flag for this mode at all (e.g. opencode's plan/build). The mode id
    // is instead forwarded to the ACP arm's connect({mode}) by
    // define-agent-cli.ts and applied via session/set_config_option. Skip
    // bin_args_prepend/bin_args_append/env here even if an author declared
    // them alongside apply:"config" — config wins, argv is never composed,
    // so a typo'd flag can't crash the spawn the way this whole bug did.
    if ((mode.apply ?? "bin_args") === "bin_args") {
      if (mode.bin_args_prepend) prepend.push(...mode.bin_args_prepend)
      if (mode.bin_args_append) append.push(...mode.bin_args_append)
      if (mode.env) Object.assign(env, mode.env)
      if (mode.env_unset) envUnset.push(...mode.env_unset)
    }
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
      if (patch.envUnset.length) envUnset.push(...patch.envUnset)
    }
  }

  // ── Model deny-list enforcement ─────────────────────────────────
  // The `model` option is deliberately free-form (any provider id), so
  // `models.allowed` is only a curated menu — it can't *prevent* a caller
  // from passing an off-menu id. `models.deny` is the hard guardrail: a
  // requested model matching any deny pattern is refused here, before we
  // spawn anything, so a budget adapter can't be steered onto a provider it
  // must never use (e.g. Anthropic models are reserved for claude-code).
  const requestedModel = config.options?.model
  if (typeof requestedModel === "string" && handle.models?.deny?.length) {
    const denyHit = handle.models.deny.find(pattern =>
      matchesModelPattern(pattern, requestedModel)
    )
    if (denyHit) {
      throw new RuntimeConfigError(
        "model_denied",
        "config.options.model",
        `Model '${requestedModel}' is denied by manifest '${handle.id}' (matches deny pattern '${denyHit}'). This adapter deliberately does not route to that provider — use a permitted model or a different adapter.`
      )
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
    envUnset,
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

/**
 * Case-insensitive match of a model id against a deny/allow pattern.
 * Supports a single trailing `*` wildcard (prefix match); otherwise exact.
 */
function matchesModelPattern(pattern: string, modelId: string): boolean {
  const p = pattern.toLowerCase()
  const m = modelId.toLowerCase()
  return p.endsWith("*") ? m.startsWith(p.slice(0, -1)) : m === p
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
): { prepend: string[]; append: string[]; env: Record<string, string>; envUnset: string[] } {
  const stringValue = String(value)

  // boolean type: only emit the bare flag when value === true and the
  // option declared `bin_args_append_when_true`. Honor `env` too —
  // adapter authors might want to surface the bool via env. Booleans
  // have no prepend counterpart — `bin_args_append_when_true` is for
  // bare flags, which never need to precede a baked-in subcommand.
  if (option.type === "boolean") {
    if (value !== true) return { prepend: [], append: [], env: {}, envUnset: [] }
    return {
      prepend: [],
      append: option.bin_args_append_when_true
        ? [...option.bin_args_append_when_true]
        : [],
      env: option.env ? interpolateEnv(option.env, stringValue) : {},
      envUnset: option.env_unset ? [...option.env_unset] : [],
    }
  }

  // value-bearing types — apply `bin_args_prepend` / `bin_args_template`
  // (with `{value}` interpolation) and merge `env`. `env_unset` applies
  // whenever the option is active with a non-default value (the same
  // condition under which `env` merges) — so a `base_url` option, e.g.,
  // scrubs the ambient ANTHROPIC_API_KEY the moment it's set.
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
    envUnset: option.env_unset ? [...option.env_unset] : [],
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
