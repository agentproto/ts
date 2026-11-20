/** Rail environment variables (AIP-74 Adapters, rule 24). Names only, never values. */
import type { BillingHandle } from "./define-billing-manifest.js"
import { defaultRailEnv } from "./settlement.js"

export interface RailEnvNames {
  rail: string
  secretKey: string
  webhookSecret: string
  mode: string
}

/** The names a rail reads: the manifest's `rails[].env` override, else the provider's, else `<RAIL>_...`. */
export function railEnvNames(
  manifest: BillingHandle,
  providerEnv?: Readonly<Record<string, { secretKey: string; webhookSecret: string; mode: string }>>,
): RailEnvNames[] {
  return manifest.rails.map(r => {
    const base = providerEnv?.[r.provider ?? r.id] ?? defaultRailEnv(r.provider ?? r.id)
    return {
      rail: r.id,
      secretKey: r.env?.secretKey ?? base.secretKey,
      webhookSecret: r.env?.webhookSecret ?? base.webhookSecret,
      mode: r.env?.mode ?? base.mode,
    }
  })
}

/**
 * Rule 24. The variables a manifest needs that the environment lacks. `mode` is
 * optional (default `test`); a rail left in `live` must say so.
 */
export function missingRailEnv(
  manifest: BillingHandle,
  env: Record<string, string | undefined>,
  providerEnv?: Readonly<Record<string, { secretKey: string; webhookSecret: string; mode: string }>>,
): string[] {
  const missing: string[] = []
  for (const n of railEnvNames(manifest, providerEnv)) {
    for (const v of [n.secretKey, n.webhookSecret]) if (!env[v]) missing.push(v)
  }
  return missing
}

/** Start-up guard: throws naming every missing variable (rule 24). */
export function assertRailEnv(
  manifest: BillingHandle,
  env: Record<string, string | undefined>,
  providerEnv?: Readonly<Record<string, { secretKey: string; webhookSecret: string; mode: string }>>,
): void {
  const missing = missingRailEnv(manifest, env, providerEnv)
  if (missing.length > 0) throw new Error(`billing '${manifest.name}': missing environment variables: ${missing.join(", ")}`)
}

export type RailMode = "test" | "live"

/** `test` unless the mode variable says `live`. Anything else is refused. */
export function railMode(value: string | undefined): RailMode {
  if (value === undefined || value === "" || value === "test") return "test"
  if (value === "live") return "live"
  throw new Error(`rail mode must be 'test' or 'live', got '${value}'`)
}

/** A live rail refuses a test key and a test rail refuses a live key. `keyMode` is the provider's reading of its own key. */
export function assertKeyMatchesMode(mode: RailMode, keyMode: RailMode | null, rail: string): void {
  if (keyMode !== null && keyMode !== mode) throw new Error(`rail '${rail}' is in ${mode} mode but its key is a ${keyMode} key`)
}
