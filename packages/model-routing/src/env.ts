/**
 * Convenience builders for `override` and `env` {@link Layer}s.
 *
 * These are NOT part of AIP-57's four primitives — the spec only says the
 * env layer conventionally reads `<PREFIX>_<KEY>_MODEL` (§3) and leaves the
 * exact parsing to the host. They exist here because all three prior
 * implementations parse a `provider:model` string and a per-key/catch-all
 * env convention, and duplicating that parsing at every call site is exactly
 * the drift AIP-57 exists to stop.
 *
 * Both stay pure per §7: they take the env record / override maps as plain
 * arguments rather than reading `process.env` themselves. The impurity
 * (`process.env` access) belongs at the call site: `envLayer("ROUTER",
 * keys, process.env)`.
 */

import type { Layer, Route } from "./types.js"

/** `triage-inline` → `TRIAGE_INLINE`; `speak` → `SPEAK`. */
export function envKeySuffix(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.\s]+/g, "_")
    .toUpperCase()
}

/**
 * Split an optional `provider:` prefix off a model ref string.
 * `knownProviders` scopes what counts as a routing prefix (vs. an
 * OpenRouter-style id that legitimately contains a colon-free slash, or any
 * other id shape a host's catalog uses) — AIP-57 does not define a provider
 * list, so the caller supplies its own.
 */
export function parseRouteRef(
  value: string,
  knownProviders: ReadonlySet<string> | readonly string[]
): { model: string; provider?: string } {
  const known = knownProviders instanceof Set ? knownProviders : new Set(knownProviders)
  const colon = value.indexOf(":")
  if (colon > 0 && colon < value.length - 1) {
    const prefix = value.slice(0, colon)
    if (known.has(prefix)) {
      return { model: value.slice(colon + 1), provider: prefix }
    }
  }
  return { model: value }
}

export interface EnvLayerOptions {
  /** Providers a `provider:model` env value may pin to; unset ⇒ never parse a provider prefix. */
  knownProviders?: ReadonlySet<string> | readonly string[]
  /** `<PREFIX>_DEFAULT_MODEL` catch-all suffix. Set to `null` to disable the catch-all entirely. Default `"DEFAULT"`. */
  catchAllSuffix?: string | null
}

/**
 * Build an `env`-sourced {@link Layer} for the given keys from `env`
 * (typically `process.env`, passed in by the caller — see module docs).
 * Reads `<PREFIX>_<KEY>_MODEL` per key and, unless disabled,
 * `<PREFIX>_DEFAULT_MODEL` as the catch-all.
 */
export function envLayer<Key extends string, R extends Route = Route>(
  prefix: string,
  keys: readonly Key[],
  env: Readonly<Record<string, string | undefined>>,
  opts: EnvLayerOptions = {}
): Layer<Key, R> {
  const { knownProviders = [], catchAllSuffix = "DEFAULT" } = opts
  const entries: Partial<Record<Key, R | null>> = {}
  for (const key of keys) {
    const raw = env[`${prefix}_${envKeySuffix(key)}_MODEL`]
    if (raw) entries[key] = parseRouteRef(raw, knownProviders) as R
  }
  const catchAllRaw = catchAllSuffix ? env[`${prefix}_${catchAllSuffix}_MODEL`] : undefined
  return {
    source: "env",
    entries,
    ...(catchAllRaw ? { catchAll: parseRouteRef(catchAllRaw, knownProviders) as R } : {}),
  }
}
