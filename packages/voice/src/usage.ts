/**
 * Usage meter: the cumulative, monotonic record a session reports (AIP-VOICE,
 * Usage record). Numbers and model names only, plus one optional opaque
 * label the host sets (`credentialSource`); no price, no content.
 */
import type { CredentialSource, VoiceEngineId, VoiceTokenBuckets, VoiceUsage, VoiceUsageEntry } from "./types.js"

export interface UsageMeter {
  addSttSeconds(provider: string, seconds: number, model?: string): void
  addTtsCharacters(provider: string, characters: number, model?: string): void
  addRealtime(
    provider: string,
    delta: { audioSeconds?: number; tokens?: Partial<VoiceTokenBuckets>; reportedCostUsd?: number },
    model?: string,
  ): void
  /**
   * Tag every entry of this session with an opaque label for whose key paid for
   * it (see `VoiceUsageEntry.credentialSource`). Session-wide: set it before the
   * first unit is counted; a later call re-labels the whole record. Ignored
   * after `seal()`.
   */
  setCredentialSource(source: CredentialSource | undefined): void
  /** A snapshot; entries are copied. */
  snapshot(): VoiceUsage
  /** Freeze: later adds are ignored (call on close). */
  seal(): void
}

/** Hand a final record to the host's `onUsage`; never throws, never rejects. */
export async function deliverUsage(
  onUsage: ((usage: VoiceUsage) => void | Promise<void>) | undefined,
  usage: VoiceUsage | undefined,
): Promise<void> {
  if (!onUsage || !usage) return
  try {
    await onUsage(usage)
  } catch {
    // a host's usage sink never affects the session
  }
}

export function makeUsageMeter(engine: VoiceEngineId, now: () => number = Date.now): UsageMeter {
  const startedAt = now()
  let sealedWall: number | undefined
  let credentialSource: CredentialSource | undefined
  const entries = new Map<string, VoiceUsageEntry>()

  const entry = (stage: VoiceUsageEntry["stage"], provider: string, model?: string) => {
    const key = `${stage}\u0000${provider}\u0000${model ?? ""}`
    let e = entries.get(key)
    if (!e) {
      e = { stage, provider, ...(model ? { model } : {}) }
      entries.set(key, e)
    }
    return e
  }
  const ok = (n: number | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0

  return {
    addSttSeconds(provider, seconds, model) {
      if (sealedWall !== undefined || !ok(seconds)) return
      const e = entry("stt", provider, model)
      e.audioSeconds = (e.audioSeconds ?? 0) + seconds
    },
    addTtsCharacters(provider, characters, model) {
      if (sealedWall !== undefined || !ok(characters)) return
      const e = entry("tts", provider, model)
      e.characters = (e.characters ?? 0) + Math.round(characters)
    },
    addRealtime(provider, delta, model) {
      if (sealedWall !== undefined) return
      const e = entry("realtime", provider, model)
      if (ok(delta.audioSeconds)) e.audioSeconds = (e.audioSeconds ?? 0) + delta.audioSeconds
      if (delta.tokens) {
        const t = (e.tokens ??= {
          audioIn: 0, audioOut: 0, textIn: 0, textOut: 0, cachedAudioIn: 0, cachedTextIn: 0,
        })
        for (const k of Object.keys(t) as Array<keyof VoiceTokenBuckets>) {
          const v = delta.tokens[k]
          if (ok(v)) t[k] += v
        }
      }
      if (ok(delta.reportedCostUsd)) e.reportedCostUsd = (e.reportedCostUsd ?? 0) + delta.reportedCostUsd
    },
    setCredentialSource(source) {
      if (sealedWall !== undefined) return
      credentialSource = source
    },
    snapshot() {
      return {
        engine,
        wallSeconds: ((sealedWall ?? now()) - startedAt) / 1000,
        entries: [...entries.values()].map(e => ({
          ...structuredClone(e),
          ...(credentialSource !== undefined ? { credentialSource } : {}),
        })),
      }
    },
    seal() {
      sealedWall ??= now()
    },
  }
}
