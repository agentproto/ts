/**
 * Provider selection from the standard variables (AIP-VOICE, Variables):
 * the priority rule, evaluated in order, with no existing value changing
 * meaning.
 *
 *  1. VOICE_PROVIDER chooses the engine and the providers it implies.
 *     Unset: the kit default (defaults.ts).
 *  2. VOICE_STT_PROVIDER / VOICE_TTS_PROVIDER count only in the cascade and
 *     win over what VOICE_PROVIDER implies for that stage. With a realtime
 *     engine they are ignored and a warning is returned.
 *  3. VOICE_ID is the voice of the TTS provider (cascade) or of the realtime
 *     provider; unset, the provider's own `<SLUG>_VOICE_ID` is read.
 *  4. A slug that does not resolve, or a provider without the stage, fails
 *     with the slug and the stage. No silent fallback.
 */
import { VOICE_DEFAULTS, VOICE_ENV } from "./defaults.js"
import type { VoiceEngineId } from "./types.js"
import type { VoiceRegistry } from "./registry.js"

/** The three `VOICE_PROVIDER` values of the studio products, with their meaning. */
const LEGACY_VOICE_PROVIDER: Record<
  string,
  { engine: VoiceEngineId; stt?: string; tts?: string; realtime?: string }
> = {
  "elevenlabs-realtime": { engine: "cascade", stt: "elevenlabs", tts: "elevenlabs" },
  "whisper-elevenlabs": { engine: "cascade", stt: "openai", tts: "elevenlabs" },
  "openai-realtime": { engine: "realtime", realtime: "openai" },
}

export interface VoiceSelection {
  engine: VoiceEngineId
  /** Slug or value alias to resolve with `registry.stt`. */
  stt?: string
  tts?: string
  /** Realtime id or slug to resolve with `registry.realtime`. */
  realtime?: string
  voiceId?: string
  language?: string
  warnings: string[]
}

export type VoiceEnvSource = Record<string, string | undefined>

const clean = (v: string | undefined): string | undefined => {
  const t = v?.trim()
  return t ? t : undefined
}

export async function resolveVoiceSelection(
  env: VoiceEnvSource,
  registry: VoiceRegistry,
): Promise<VoiceSelection> {
  const warnings: string[] = []
  const provider = clean(env[VOICE_ENV.provider])
  const sttVar = clean(env[VOICE_ENV.sttProvider])
  const ttsVar = clean(env[VOICE_ENV.ttsProvider])
  const language = clean(env[VOICE_ENV.language])

  let engine: VoiceEngineId
  let stt: string | undefined
  let tts: string | undefined
  let realtime: string | undefined

  if (!provider) {
    engine = VOICE_DEFAULTS.selection.engine.value
    if (engine === "cascade") {
      stt = VOICE_DEFAULTS.selection.stt.value
      tts = VOICE_DEFAULTS.selection.tts.value
    } else {
      realtime = VOICE_DEFAULTS.selection.realtime.value
    }
  } else if (LEGACY_VOICE_PROVIDER[provider]) {
    const l = LEGACY_VOICE_PROVIDER[provider]!
    engine = l.engine
    stt = l.stt
    tts = l.tts
    realtime = l.realtime
  } else {
    // A realtime provider adds a value by declaring `capabilities.id`.
    const all = await registry.all()
    const hit = all.find(p => p.realtime?.capabilities.id === provider)
    if (!hit) {
      throw new Error(
        `VOICE_PROVIDER="${provider}" is not a known value: use one of ${Object.keys(LEGACY_VOICE_PROVIDER).join(", ")} or a realtime id declared by an installed provider`,
      )
    }
    engine = "realtime"
    realtime = provider
  }

  if (engine === "cascade") {
    if (sttVar) stt = sttVar
    if (ttsVar) tts = ttsVar
  } else if (sttVar || ttsVar) {
    warnings.push(
      `${VOICE_ENV.sttProvider} and ${VOICE_ENV.ttsProvider} are ignored with a realtime engine`,
    )
  }

  // Rule 4: resolve now so a bad slug fails at startup with slug and stage.
  let voiceSlug: string
  if (engine === "cascade") {
    await registry.stt(stt!)
    voiceSlug = (await registry.tts(tts!)).slug
  } else {
    voiceSlug = (await registry.realtime(realtime!)).slug
  }

  const voiceId =
    clean(env[VOICE_ENV.voiceId]) ??
    clean(env[`${voiceSlug.toUpperCase().replace(/-/g, "_")}_VOICE_ID`])

  return {
    engine,
    ...(stt ? { stt } : {}),
    ...(tts ? { tts } : {}),
    ...(realtime ? { realtime } : {}),
    ...(voiceId ? { voiceId } : {}),
    ...(language ? { language } : {}),
    warnings,
  }
}
