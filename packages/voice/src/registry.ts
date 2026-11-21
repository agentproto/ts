/**
 * The voice provider registry, mounted with `makeProviderFamily()`
 * (@agentproto/provider-kit). A slug resolves to a `VoiceProvider` either from
 * a provider registered in process (tests, a product that bundles one) or from
 * a dynamic import of `@agentproto/voice-<slug>`.
 *
 * No provider lives in this package: the catalog only names the packages.
 */
import {
  makeEnvCredsStore,
  makeMemorySetupLedger,
  makeProviderFamily,
  type AdapterCatalog,
  type FamilyHandle,
  type FamilyCreds,
  type ProviderFamily,
} from "@agentproto/provider-kit"
import type {
  RealtimeProvider,
  SttProvider,
  TtsProvider,
  VoiceProvider,
} from "./types.js"
import { apiKeyName } from "./define.js"

export const VOICE_CATALOG: AdapterCatalog = [
  { slug: "elevenlabs", name: "ElevenLabs", description: "TTS, Scribe STT and a hosted speech-to-speech agent", packageName: "@agentproto/voice-elevenlabs", hint: "stt · tts · realtime" },
  { slug: "openai", name: "OpenAI", description: "File and streaming STT, TTS and the Realtime API", packageName: "@agentproto/voice-openai", hint: "stt · tts · realtime" },
  { slug: "assemblyai", name: "AssemblyAI", description: "Streaming and file STT, and TTS", packageName: "@agentproto/voice-assemblyai", hint: "stt · tts" },
  { slug: "gemini", name: "Gemini", description: "Gemini Live realtime", packageName: "@agentproto/voice-gemini", hint: "realtime" },
]

/** Safe descriptor of a provider. Never carries a credential value. */
export interface VoiceProviderInfo {
  slug: string
  stages: Array<"stt" | "tts" | "realtime">
  apiKeyVariable: string
  realtimeId?: string
}

interface VoiceHandle extends FamilyHandle {
  readonly provider: VoiceProvider
}

export function toVoiceHandle(provider: VoiceProvider): VoiceHandle {
  return {
    slug: provider.slug,
    name: provider.name,
    version: "0.0.0",
    description: provider.name,
    requiresSetup: true,
    provider,
    setupFields: [
      { name: provider.env.apiKey, description: `${provider.name} API key`, sensitive: true },
    ],
    async check() {
      return true
    },
  }
}

const isVoiceProvider = (v: unknown): v is VoiceProvider =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as VoiceProvider).slug === "string" &&
  typeof (v as VoiceProvider).capabilities === "object"

export interface VoiceRegistryOptions {
  /** Providers registered in process, keyed by slug. Tried before any import. */
  providers?: readonly VoiceProvider[]
  /** Environment to read keys from. Default: `process.env`. */
  env?: Record<string, string | undefined>
  /** Import seam, for tests. Default: native dynamic `import()`. */
  importPackage?: (packageName: string) => Promise<Record<string, unknown>>
}

export interface VoiceRegistry {
  readonly family: ProviderFamily<VoiceHandle, VoiceProviderInfo>
  /** A provider by slug, or null. */
  provider(slug: string): Promise<VoiceProvider | null>
  /** A stage by slug or value alias; throws naming the slug and the stage. */
  stt(slugOrAlias: string): Promise<SttProvider>
  tts(slugOrAlias: string): Promise<TtsProvider>
  realtime(slugOrId: string): Promise<RealtimeProvider>
  /** Every provider that resolves. */
  all(): Promise<VoiceProvider[]>
  /** The API key of a provider, from `<SLUG>_API_KEY` or a declared alias. */
  apiKey(provider: VoiceProvider): string | undefined
}

export function makeVoiceRegistry(opts: VoiceRegistryOptions = {}): VoiceRegistry {
  const env = opts.env ?? process.env
  const local = new Map((opts.providers ?? []).map(p => [p.slug, p]))
  const knownSlugs = [
    ...new Set([...VOICE_CATALOG.map(e => e.slug), ...local.keys()]),
  ]
  const vars: Record<string, Record<string, string>> = {}
  for (const slug of knownSlugs) {
    const key = local.get(slug)?.env.apiKey ?? apiKeyName(slug)
    vars[slug] = { [key]: key }
  }
  const credsStore = makeEnvCredsStore({ env, vars })
  const family = makeProviderFamily<VoiceHandle, VoiceProviderInfo>({
    family: "voice",
    catalog: [
      ...VOICE_CATALOG,
      ...[...local.values()]
        .filter(p => !VOICE_CATALOG.some(e => e.slug === p.slug))
        .map(p => ({
          slug: p.slug,
          name: p.name,
          description: p.name,
          packageName: `@agentproto/voice-${p.slug}`,
        })),
    ],
    credsStore,
    ledger: makeMemorySetupLedger(),
    toInfo: h => ({
      slug: h.slug,
      stages: (["stt", "tts", "realtime"] as const).filter(s => h.provider[s]),
      apiKeyVariable: h.provider.env.apiKey,
      ...(h.provider.realtime ? { realtimeId: h.provider.realtime.capabilities.id } : {}),
    }),
    load: async (slug, ctx) => {
      const inProcess = local.get(slug)
      if (inProcess) return toVoiceHandle(inProcess)
      const mod = await ctx.importPackage(ctx.entry.packageName)
      const candidate = mod.default ?? mod.provider ?? Object.values(mod).find(isVoiceProvider)
      return isVoiceProvider(candidate) ? toVoiceHandle(candidate) : null
    },
    ...(opts.importPackage ? { importPackage: opts.importPackage } : {}),
  })

  const provider = async (slug: string) => (await family.resolve(slug))?.provider ?? null

  const all = async () => {
    const out: VoiceProvider[] = []
    for (const e of family.catalog) {
      const p = await provider(e.slug)
      if (p) out.push(p)
    }
    return out
  }

  const findByAlias = async (stage: "stt" | "tts", value: string) => {
    const hits = (await all()).filter(
      p => p[stage] && (p.slug === value || p.valueAliases[stage].includes(value)),
    )
    if (hits.length > 1) {
      throw new Error(
        `voice ${stage} value "${value}" is declared by several providers: ${hits.map(h => h.slug).join(", ")}`,
      )
    }
    return hits[0] ?? null
  }

  const stage = async <K extends "stt" | "tts">(k: K, value: string) => {
    const bySlug = await provider(value)
    const p = bySlug ?? (await findByAlias(k, value))
    if (!p) throw new Error(`voice provider "${value}" does not resolve (stage ${k})`)
    const impl = p[k]
    if (!impl) throw new Error(`voice provider "${p.slug}" has no ${k} stage`)
    return impl as NonNullable<VoiceProvider[K]>
  }

  return {
    family,
    provider,
    all,
    stt: v => stage("stt", v) as Promise<SttProvider>,
    tts: v => stage("tts", v) as Promise<TtsProvider>,
    async realtime(value) {
      const providers = await all()
      const byId = providers.find(p => p.realtime?.capabilities.id === value)
      const p = byId ?? (await provider(value))
      if (!p) throw new Error(`voice provider "${value}" does not resolve (stage realtime)`)
      if (!p.realtime) throw new Error(`voice provider "${p.slug}" has no realtime stage`)
      return p.realtime
    },
    apiKey(p) {
      for (const name of [p.env.apiKey, ...p.env.aliases]) {
        const v = env[name]
        if (v) return v
      }
      return undefined
    },
  }
}

export type { FamilyCreds }
