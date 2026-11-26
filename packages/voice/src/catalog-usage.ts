/**
 * Usage record -> per-stage billable events keyed by a model-catalog id.
 *
 * The meter only counts units (audio seconds, TTS characters). A host that
 * prices them needs a catalog id per entry; this is the generic mapping, with
 * no vendor knowledge built in: a host describes each provider once.
 */
import type { CredentialSource, VoiceUsage } from "./types.js"

export interface CatalogProviderMapping {
  /** Catalog namespace for this provider. Default: the provider slug. */
  prefix?: string
  /** Vendor prefix removed from the model before normalising (e.g. `acme_`). */
  stripModelPrefix?: string
  /** Model used when the entry carries none, per stage. */
  fallbackModel?: { stt?: string; tts?: string }
}

export interface CatalogUsageOptions {
  /** Providers to bill, by slug. Entries of other providers are returned as `unbilled`. */
  providers: Record<string, CatalogProviderMapping>
}

export interface CatalogUsageEvent {
  kind: "stt" | "tts"
  provider: string
  modelId: string
  /** TTS. */
  characters?: number
  /** STT, rounded to 0.1 s. */
  seconds?: number
  /** Copied from the usage entry: whose key paid. Absent when the entry carries none. */
  credentialSource?: CredentialSource
}

/** `acme_fast_2_5` -> `fast-2.5` (with `stripModelPrefix: "acme_"`). */
export function normalizeModelId(model: string, stripPrefix?: string): string {
  const m = stripPrefix && model.startsWith(stripPrefix) ? model.slice(stripPrefix.length) : model
  return m.replace(/_(\d+)$/, ".$1").replace(/_/g, "-")
}

export function catalogModelId(
  provider: string,
  mapping: CatalogProviderMapping,
  stage: "stt" | "tts",
  model?: string,
): string | undefined {
  const m = model ?? mapping.fallbackModel?.[stage]
  if (!m) return undefined
  return `${mapping.prefix ?? provider}/${normalizeModelId(m, mapping.stripModelPrefix)}`
}

const tag = (e: { credentialSource?: CredentialSource }) =>
  e.credentialSource ? { credentialSource: e.credentialSource } : {}

export function usageToCatalogEvents(
  usage: VoiceUsage,
  opts: CatalogUsageOptions,
): { events: CatalogUsageEvent[]; unbilled: string[] } {
  const events: CatalogUsageEvent[] = []
  const unbilled: string[] = []
  for (const e of usage.entries) {
    const mapping = opts.providers[e.provider]
    if (!mapping || e.stage === "realtime") {
      unbilled.push(`${e.stage}:${e.provider}`)
      continue
    }
    const modelId = catalogModelId(e.provider, mapping, e.stage, e.model)
    if (e.stage === "tts" && (e.characters ?? 0) > 0) {
      if (!modelId) unbilled.push(`tts:${e.provider}`)
      else events.push({ kind: "tts", provider: e.provider, modelId, characters: e.characters as number, ...tag(e) })
    } else if (e.stage === "stt" && (e.audioSeconds ?? 0) > 0) {
      if (!modelId) unbilled.push(`stt:${e.provider}`)
      else {
        events.push({
          kind: "stt",
          provider: e.provider,
          modelId,
          seconds: Math.round((e.audioSeconds as number) * 10) / 10,
          ...tag(e),
        })
      }
    }
  }
  return { events, unbilled }
}
