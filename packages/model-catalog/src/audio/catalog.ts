/**
 * Audio Model Catalog — TTS + STT provider models.
 *
 * Pairs with the voice catalog (`@agentproto/model-catalog/voice`) but a
 * separate concern: voices describe *what the output sounds like*, models
 * here describe *how the provider bills*. A single TTS model (e.g.
 * ElevenLabs `multilingual-v2`) can render hundreds of voices at the
 * same rate.
 *
 * Billing follows the per-kind dispatcher in `cost/index.ts`:
 *   - TTS bills `per_1k_chars` (multiply characters/1000 × creditCost)
 *   - STT bills `per_minute` (multiply ceil(seconds/60) × creditCost)
 *
 * Adding a model = 1 entry here + (if used by an integration) a
 * provider call-site that passes the model id to the cost dispatcher
 * so `calculateCost(modelId, { kind: "audio", characters / seconds })`
 * returns real numbers instead of the placeholder.
 *
 * Prices are point-in-time (refresh monthly via the drift-check
 * script). Sources noted per entry — production cost ≠ retail; we
 * markup ~1.25-1.5× into `creditCost` (displayed credits, 1 cred ≈
 * €0.01) consistent with the image/video catalogs.
 */

import type { AudioCapabilities } from "../schema/audio.js"

/**
 * Audio MODALITY labels — what an audio model does. A model may do more
 * than one (e.g. a combined engine, or a provider exposing both cascade
 * TTS and conversational s2s), so these are boolean flags on
 * `AudioCapabilities`, not a single discriminator. The model's catalog
 * `kind` is always the family `"audio"`; modality lives here.
 *   - `tts` — text → speech
 *   - `stt` — speech → text
 *   - `s2s` — speech ↔ speech (one model; distinct from a tts+llm+stt cascade)
 */
export type AudioModality = "tts" | "stt" | "s2s"

export type AudioBillingUnit = "per_1k_chars" | "per_minute" | "per_second"

export type AudioProvider =
  | "elevenlabs"
  | "minimax"
  | "openai"
  | "replicate"
  | "deepgram"
  | "assemblyai"
  | "google"

export interface AudioPricing {
  /** How the provider charges (drives the cost dispatcher math). */
  billingUnit: AudioBillingUnit
  /** Production cost in USD per `billingUnit`. */
  baseCost: number
  /**
   * @deprecated Credits derived at call time via
   * `computeCenticredits({ baseCostUsd: baseCost, category: "audio" })`.
   * Kept optional for back-compat with existing entries.
   */
  creditCost?: number
  /** Bypass markup formula and charge exactly this many credits per billingUnit. */
  overrideCreditCost?: number
}

// `AudioCapabilities` is owned by the zod schema (`../schema/audio.ts`) —
// single source of truth (imported at the top). Re-exported so existing
// `@agentproto/model-catalog/audio` consumers keep importing it from here.
export type { AudioCapabilities }

export interface AudioModelDefinition {
  id: string
  name: string
  /** Provider-facing identifier (e.g. `eleven_multilingual_v2`, `nova-3`). */
  providerId: string
  provider: AudioProvider
  capabilities: AudioCapabilities
  pricing: AudioPricing
  description: string
  agentVisible: boolean
}

export const AUDIO_MODEL_CATALOG: Record<string, AudioModelDefinition> = {
  // ─── Speech-to-speech / realtime ────────────────────────────────────────
  // Provider runs the LLM in-session (no separate STT+TTS billing). These
  // bill on active session duration — `per_minute` reuses the same cost
  // path STT uses, fed `seconds` from the voice pod's session timer.
  // baseCost = blended USD/min (audio in+out), point-in-time; refresh via
  // the drift-check script. agentVisible:false — these are call engines,
  // not agent-selectable tool models.
  // `id` is our stable internal billing id (wired into the voice engine
  // descriptors); `providerId` is the live provider model string —
  // refresh it as providers ship new realtime models.
  // Gemini Live — the three provider IDs the adapter accepts. This
  // catalog is the source of truth for those ids + the default; the
  // adapter / tts-providers / env should resolve from here, not
  // re-hardcode. Default = flash (low latency, the call default).
  "google/gemini-live": {
    id: "google/gemini-live",
    name: "Gemini Live 3.1 Flash",
    // A bidi Live model, not a TTS-only one: the Live API refuses the
    // `*-preview-tts` variants (they only take HTTP text input). This is the
    // default the studio engine itself runs (agent-framework
    // voice/strategies/engines.ts:189).
    providerId: "gemini-3.1-flash-live-preview",
    provider: "google",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      // ~$0.10/min blended audio in+out (Gemini Live token rates).
      baseCost: 0.1,
    },
    description: "Google Gemini Live realtime s2s — low latency (default)",
    agentVisible: false,
  },
  "google/gemini-live-pro": {
    id: "google/gemini-live-pro",
    name: "Gemini Live 2.5 Pro",
    // A bidi Live model, not a TTS-only one (same rule as google/gemini-live).
    providerId: "gemini-2.5-pro-live-preview",
    provider: "google",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      // Heavier/higher-quality tier — ~2× flash.
      baseCost: 0.2,
    },
    description: "Google Gemini Live realtime s2s — higher quality",
    agentVisible: false,
  },
  "google/gemini-live-3.1-flash": {
    id: "google/gemini-live-3.1-flash",
    name: "Gemini Live 3.1 Flash",
    // The version-explicit sibling of google/gemini-live: the SAME bidi
    // Live model (not a TTS-only id, same rule as the entries around it).
    providerId: "gemini-3.1-flash-live-preview",
    provider: "google",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.1,
    },
    description: "Google Gemini Live realtime s2s — 3.1 flash preview",
    agentVisible: false,
  },
  "openai/gpt-realtime": {
    id: "openai/gpt-realtime",
    name: "OpenAI Realtime (gpt-realtime-1.5)",
    // gpt-realtime-1.5 = best audio-in/audio-out realtime model.
    // Variants: gpt-realtime-2 (reasoning), gpt-realtime-mini (cheap),
    // gpt-realtime-translate (s2s translation).
    providerId: "gpt-realtime-1.5",
    provider: "openai",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      // ~$0.30/min blended (audio in + out). Verify via drift-check.
      baseCost: 0.3,
    },
    description: "OpenAI realtime speech-to-speech (best audio in/out)",
    agentVisible: false,
  },
  "openai/gpt-realtime-mini": {
    id: "openai/gpt-realtime-mini",
    name: "OpenAI Realtime mini",
    providerId: "gpt-realtime-mini",
    provider: "openai",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      // Cost-efficient realtime tier — ~⅓ of gpt-realtime-1.5.
      baseCost: 0.1,
    },
    description: "Cost-efficient OpenAI realtime speech-to-speech",
    agentVisible: false,
  },
  // ─── 2026-11-20 refresh: newest OpenAI + Google realtime / live audio ───
  // Sources (fetched 2026-11-20): developers.openai.com/api/docs/models,
  // developers.openai.com/api/docs/pricing, aistudio.google.com/docs/models and
  // /docs/pricing. GPT-Live is served on `v1/live/sessions`, NOT `v1/realtime`:
  // a Realtime integration is not compatible, the call site must target Live.
  // `baseCost` for the live engines is the published per-minute rate (GPT-Live
  // also has a $0.02/min standby tier for WebRTC sessions while inference is
  // paused; backend model and tool usage is billed separately).
  "openai/gpt-live-1.1": {
    id: "openai/gpt-live-1.1",
    name: "OpenAI GPT-Live 1.1",
    providerId: "gpt-live-1.1",
    provider: "openai",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      // $0.05/min active (billed per second), $0.02/min standby.
      baseCost: 0.05,
    },
    description:
      "OpenAI full-duplex voice model (Live API, v1/live/sessions) — listens while it speaks",
    agentVisible: false,
  },
  // Token-billed realtime models. `baseCost` is an ESTIMATE of the blended
  // USD/min assuming ~600 audio-in and ~1200 audio-out tokens per active
  // minute at the published audio rates (2.1: $32 in / $64 out per 1M tokens;
  // 2.1-mini: $10 / $20). Refresh via the drift-check script.
  "openai/gpt-realtime-2.1": {
    id: "openai/gpt-realtime-2.1",
    name: "OpenAI Realtime 2.1",
    providerId: "gpt-realtime-2.1",
    provider: "openai",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.096,
    },
    description: "OpenAI realtime speech-to-speech with reasoning and tool use",
    agentVisible: false,
  },
  "openai/gpt-realtime-2.1-mini": {
    id: "openai/gpt-realtime-2.1-mini",
    name: "OpenAI Realtime 2.1 mini",
    providerId: "gpt-realtime-2.1-mini",
    provider: "openai",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.03,
    },
    description: "OpenAI cost-efficient realtime speech-to-speech with tool use",
    agentVisible: false,
  },
  "openai/gpt-realtime-translate": {
    id: "openai/gpt-realtime-translate",
    name: "OpenAI Realtime Translate",
    providerId: "gpt-realtime-translate",
    provider: "openai",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      // Published as an estimated per-minute cost (no token rates).
      baseCost: 0.034,
    },
    description: "OpenAI streaming speech-to-speech translation",
    agentVisible: false,
  },
  "openai/gpt-transcribe": {
    id: "openai/gpt-transcribe",
    name: "OpenAI GPT Transcribe",
    providerId: "gpt-transcribe",
    provider: "openai",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
      languageDetection: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.0045,
    },
    description: "OpenAI file and Realtime-input transcription",
    agentVisible: true,
  },
  "openai/gpt-live-transcribe": {
    id: "openai/gpt-live-transcribe",
    name: "OpenAI GPT-Live Transcribe",
    providerId: "gpt-live-transcribe",
    provider: "openai",
    capabilities: {
      stt: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.017,
    },
    description: "OpenAI low-latency realtime transcription",
    agentVisible: true,
  },
  "openai/gpt-realtime-whisper": {
    id: "openai/gpt-realtime-whisper",
    name: "OpenAI Realtime Whisper",
    providerId: "gpt-realtime-whisper",
    provider: "openai",
    capabilities: {
      stt: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.017,
    },
    description: "OpenAI streaming realtime transcription",
    agentVisible: true,
  },
  // Gemini Live (Live API). Internal ids follow the existing
  // `google/gemini-live-<version>` family; `providerId` is the exact API model.
  // Published per-minute audio rates: $0.005/min in +
  // $0.018/min out = $0.023/min blended. Both variants share one pricing block.
  "google/gemini-live-3.8": {
    id: "google/gemini-live-3.8",
    name: "Gemini 3.8 Live",
    providerId: "gemini-3.8-live",
    provider: "google",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.023,
    },
    description: "Google Gemini 3.8 Live realtime speech-to-speech",
    agentVisible: false,
  },
  "google/gemini-live-3.8-extended-thinking": {
    id: "google/gemini-live-3.8-extended-thinking",
    name: "Gemini 3.8 Live (extended thinking)",
    providerId: "gemini-3.8-live-extended-thinking",
    provider: "google",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.023,
    },
    description: "Google Gemini 3.8 Live with extended thinking",
    agentVisible: false,
  },
  "google/gemini-live-3.5-translate-preview": {
    id: "google/gemini-live-3.5-translate-preview",
    name: "Gemini 3.5 Live Translate (preview)",
    providerId: "gemini-3.5-live-translate-preview",
    provider: "google",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      // Google's own combined estimate (~$0.0368/min).
      baseCost: 0.0368,
    },
    description: "Google Gemini live speech translation (preview)",
    agentVisible: false,
  },
  // Gemini TTS. Priced per audio second from the published ~$0.00225 /
  // $0.0015 per 10 s of audio. Rates apply through 2026-12-31; Google doubles
  // them from 2027-01-01 (refresh then).
  "google/gemini-3.8-flash-tts": {
    id: "google/gemini-3.8-flash-tts",
    name: "Gemini 3.8 Flash TTS",
    providerId: "gemini-3.8-flash-tts",
    provider: "google",
    capabilities: {
      tts: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_second",
      baseCost: 0.000225,
    },
    description: "Google Gemini 3.8 Flash text-to-speech",
    agentVisible: true,
  },
  "google/gemini-3.8-flash-lite-tts": {
    id: "google/gemini-3.8-flash-lite-tts",
    name: "Gemini 3.8 Flash Lite TTS",
    providerId: "gemini-3.8-flash-lite-tts",
    provider: "google",
    capabilities: {
      tts: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_second",
      baseCost: 0.00015,
    },
    description: "Google Gemini 3.8 Flash Lite text-to-speech",
    agentVisible: true,
  },

  "elevenlabs/conversational": {
    id: "elevenlabs/conversational",
    name: "ElevenLabs Conversational",
    providerId: "conversational-v1",
    provider: "elevenlabs",
    capabilities: {
      s2s: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_minute",
      // ElevenLabs Conversational AI ~$0.10/min on the business tier.
      baseCost: 0.1,
    },
    description: "ElevenLabs Conversational AI (agent-id s2s flow)",
    agentVisible: false,
  },

  // ─── ElevenLabs TTS ─────────────────────────────────────────────────────
  // Source: https://elevenlabs.io/pricing (per 1k chars rates derived from
  // tiered credit packages — verified against direct ElevenLabs API quotes).
  "elevenlabs/multilingual-v2": {
    id: "elevenlabs/multilingual-v2",
    name: "ElevenLabs Multilingual v2",
    providerId: "eleven_multilingual_v2",
    provider: "elevenlabs",
    capabilities: {
      tts: true,
      languages: ["multi"],
      voiceCloning: true,
      streaming: true,
    },
    pricing: {
      billingUnit: "per_1k_chars",
      baseCost: 0.3,
      creditCost: 30,
    },
    description: "Premium quality, 29 languages, voice cloning",
    agentVisible: true,
  },
  "elevenlabs/turbo-v2.5": {
    id: "elevenlabs/turbo-v2.5",
    name: "ElevenLabs Turbo v2.5",
    providerId: "eleven_turbo_v2_5",
    provider: "elevenlabs",
    capabilities: {
      tts: true,
      languages: ["multi"],
      voiceCloning: true,
      streaming: true,
    },
    pricing: {
      billingUnit: "per_1k_chars",
      baseCost: 0.15,
      creditCost: 15,
    },
    description: "Mid-tier — half the cost of Multilingual, ~300ms latency",
    agentVisible: true,
  },
  "elevenlabs/flash-v2.5": {
    id: "elevenlabs/flash-v2.5",
    name: "ElevenLabs Flash v2.5",
    providerId: "eleven_flash_v2_5",
    provider: "elevenlabs",
    capabilities: {
      tts: true,
      languages: ["multi"],
      voiceCloning: true,
      streaming: true,
    },
    pricing: {
      billingUnit: "per_1k_chars",
      baseCost: 0.075,
      creditCost: 8,
    },
    description: "Lowest cost, ~75ms latency — voice-chat tier",
    agentVisible: true,
  },

  // ─── ElevenLabs STT ─────────────────────────────────────────────────────
  "elevenlabs/scribe-v1": {
    id: "elevenlabs/scribe-v1",
    name: "ElevenLabs Scribe v1",
    providerId: "scribe_v1",
    provider: "elevenlabs",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
      diarization: true,
      languageDetection: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.00667,
      creditCost: 1,
    },
    description: "ElevenLabs transcription with diarization",
    agentVisible: true,
  },

  // ─── OpenAI TTS ─────────────────────────────────────────────────────────
  // Source: https://openai.com/api/pricing/ — $15/1M chars (tts-1), $30 (hd).
  "openai/tts-1": {
    id: "openai/tts-1",
    name: "OpenAI TTS-1",
    providerId: "tts-1",
    provider: "openai",
    capabilities: {
      tts: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_1k_chars",
      baseCost: 0.015,
      creditCost: 2,
    },
    description: "OpenAI text-to-speech (standard)",
    agentVisible: true,
  },
  "openai/tts-1-hd": {
    id: "openai/tts-1-hd",
    name: "OpenAI TTS-1 HD",
    providerId: "tts-1-hd",
    provider: "openai",
    capabilities: {
      tts: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_1k_chars",
      baseCost: 0.03,
      creditCost: 4,
    },
    description: "OpenAI text-to-speech (HD)",
    agentVisible: true,
  },
  "openai/gpt-4o-mini-tts": {
    id: "openai/gpt-4o-mini-tts",
    name: "OpenAI GPT-4o mini TTS",
    providerId: "gpt-4o-mini-tts",
    provider: "openai",
    capabilities: {
      tts: true,
      languages: ["multi"],
      streaming: true,
    },
    pricing: {
      billingUnit: "per_1k_chars",
      // GPT-4o mini TTS — steerable speech, billed per char.
      baseCost: 0.015,
    },
    description: "OpenAI GPT-4o mini text-to-speech (steerable)",
    agentVisible: true,
  },

  // ─── OpenAI STT ─────────────────────────────────────────────────────────
  "openai/whisper-1": {
    id: "openai/whisper-1",
    name: "OpenAI Whisper",
    providerId: "whisper-1",
    provider: "openai",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
      languageDetection: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.006,
      creditCost: 1,
    },
    description: "OpenAI Whisper transcription",
    agentVisible: true,
  },
  // Source: https://openai.com/api/pricing/ (verified via costgoat.com/pricing/
  // openai-transcription, fetched 2026-05-29) — gpt-4o-transcribe ~$0.006/min,
  // gpt-4o-mini-transcribe ~$0.003/min (token-based billing exposed per-minute).
  "openai/gpt-4o-transcribe": {
    id: "openai/gpt-4o-transcribe",
    name: "OpenAI GPT-4o Transcribe",
    providerId: "gpt-4o-transcribe",
    provider: "openai",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
      languageDetection: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.006,
    },
    description: "OpenAI GPT-4o transcription — higher accuracy than Whisper",
    agentVisible: true,
  },
  "openai/gpt-4o-mini-transcribe": {
    id: "openai/gpt-4o-mini-transcribe",
    name: "OpenAI GPT-4o mini Transcribe",
    providerId: "gpt-4o-mini-transcribe",
    provider: "openai",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
      languageDetection: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.003,
    },
    description: "OpenAI GPT-4o mini transcription — cheapest OpenAI STT",
    agentVisible: true,
  },

  // ─── MiniMax TTS ────────────────────────────────────────────────────────
  // Voices live in `@agentproto/model-catalog/voice`; pricing keyed on model.
  "minimax/speech-02-hd": {
    id: "minimax/speech-02-hd",
    name: "MiniMax Speech 02 HD",
    providerId: "speech-02-hd",
    provider: "minimax",
    capabilities: {
      tts: true,
      languages: ["multi"],
      voiceCloning: true,
      streaming: true,
    },
    pricing: {
      billingUnit: "per_1k_chars",
      baseCost: 0.018,
      creditCost: 2,
    },
    description: "MiniMax HD voice synthesis with cloning",
    agentVisible: true,
  },
  "minimax/speech-02-turbo": {
    id: "minimax/speech-02-turbo",
    name: "MiniMax Speech 02 Turbo",
    providerId: "speech-02-turbo",
    provider: "minimax",
    capabilities: {
      tts: true,
      languages: ["multi"],
      voiceCloning: true,
      streaming: true,
    },
    pricing: {
      billingUnit: "per_1k_chars",
      baseCost: 0.01,
      creditCost: 1,
    },
    description: "MiniMax low-latency TTS",
    agentVisible: true,
  },

  // ─── Deepgram STT ───────────────────────────────────────────────────────
  // Source: https://deepgram.com/pricing — Nova-3 streaming $0.0058/min,
  // batch $0.0048/min; Nova-2 streaming $0.0043, batch $0.0036.
  "deepgram/nova-3": {
    id: "deepgram/nova-3",
    name: "Deepgram Nova-3",
    providerId: "nova-3",
    provider: "deepgram",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
      diarization: true,
      languageDetection: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.0048,
      creditCost: 1,
    },
    description: "Latest Deepgram model — best accuracy",
    agentVisible: true,
  },
  "deepgram/nova-2": {
    id: "deepgram/nova-2",
    name: "Deepgram Nova-2",
    providerId: "nova-2",
    provider: "deepgram",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
      diarization: true,
      languageDetection: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.0036,
      creditCost: 1,
    },
    description: "Production Deepgram model — battle-tested",
    agentVisible: true,
  },

  // ─── AssemblyAI STT ─────────────────────────────────────────────────────
  // Source: https://www.assemblyai.com/pricing — Universal-2 $0.37/hour,
  // Nano $0.12/hour. Per-minute math: /60.
  "assemblyai/universal-2": {
    id: "assemblyai/universal-2",
    name: "AssemblyAI Universal-2",
    providerId: "best",
    provider: "assemblyai",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
      diarization: true,
      languageDetection: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.00617,
      creditCost: 1,
    },
    description: "AssemblyAI flagship — high accuracy, slow",
    agentVisible: true,
  },
  "assemblyai/nano": {
    id: "assemblyai/nano",
    name: "AssemblyAI Nano",
    providerId: "nano",
    provider: "assemblyai",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.002,
      creditCost: 1,
    },
    description: "AssemblyAI fast tier",
    agentVisible: true,
  },

  // ─── Replicate-hosted STT (cheap, slow) ─────────────────────────────────
  // Source: https://replicate.com/<owner>/<model> per-run pricing pages.
  "replicate/incredibly-fast-whisper": {
    id: "replicate/incredibly-fast-whisper",
    name: "Incredibly Fast Whisper (Replicate)",
    providerId: "vaibhavs10/incredibly-fast-whisper",
    provider: "replicate",
    capabilities: {
      stt: true,
      languages: ["multi"],
      timestamps: true,
      languageDetection: true,
    },
    pricing: {
      billingUnit: "per_minute",
      baseCost: 0.0023,
      creditCost: 1,
    },
    description: "Whisper-large-v3 on Replicate, fast-decoded",
    agentVisible: true,
  },

  // ─── Replicate-hosted TTS ───────────────────────────────────────────────
  // Estimates per ~30s clip → per-1k-chars normalization (~150 chars / 30s).
  "replicate/chatterbox": {
    id: "replicate/chatterbox",
    name: "Chatterbox (Replicate)",
    providerId: "resemble-ai/chatterbox",
    provider: "replicate",
    capabilities: {
      tts: true,
      languages: ["en"],
      voiceCloning: true,
    },
    pricing: {
      billingUnit: "per_1k_chars",
      baseCost: 0.02,
      creditCost: 2,
    },
    description: "Replicate-hosted voice cloning TTS",
    agentVisible: false,
  },
}

// ─── Derived arrays ──────────────────────────────────────────────────────

export const AUDIO_MODEL_IDS = Object.keys(AUDIO_MODEL_CATALOG) as [
  string,
  ...string[],
]

export const AGENT_AUDIO_MODEL_IDS = Object.entries(AUDIO_MODEL_CATALOG)
  .filter(([, m]) => m.agentVisible)
  .map(([id]) => id) as [string, ...string[]]

export const AGENT_TTS_MODEL_IDS = Object.entries(AUDIO_MODEL_CATALOG)
  .filter(([, m]) => m.agentVisible && m.capabilities.tts)
  .map(([id]) => id) as [string, ...string[]]

export const AGENT_STT_MODEL_IDS = Object.entries(AUDIO_MODEL_CATALOG)
  .filter(([, m]) => m.agentVisible && m.capabilities.stt)
  .map(([id]) => id) as [string, ...string[]]

// ─── S2S / Gemini Live source of truth ───────────────────────────────────
// These were hardcoded (and drifting) across the gemini-live adapter,
// tts-providers, and per-app voice env. The catalog is the single source;
// consumers should import from here instead of re-declaring the strings.

/** All catalog s2s entry ids (internal billing ids). */
export const S2S_MODEL_IDS = Object.entries(AUDIO_MODEL_CATALOG)
  .filter(([, m]) => m.capabilities.s2s)
  .map(([id]) => id)

/** Provider model strings the Gemini Live adapter accepts server-side,
 *  derived from the catalog's google/s2s entries. */
export const GEMINI_LIVE_MODEL_IDS: string[] = Object.values(
  AUDIO_MODEL_CATALOG
)
  .filter(m => m.capabilities.s2s && m.provider === "google")
  .map(m => m.providerId)

/** Default Gemini Live model — the low-latency flash tier (`google/gemini-live`). */
export const DEFAULT_GEMINI_LIVE_MODEL: string =
  AUDIO_MODEL_CATALOG["google/gemini-live"]?.providerId ??
  "gemini-3.1-flash-live-preview"

/** True when `id` is one of the accepted Gemini Live provider model strings. */
export function isAcceptedGeminiLiveModel(id: string): boolean {
  return GEMINI_LIVE_MODEL_IDS.includes(id)
}

/** Generate a markdown table of agent-visible TTS / STT models for prompt blocks */
export function generateAudioModelTable(modality?: AudioModality): string {
  return Object.values(AUDIO_MODEL_CATALOG)
    .filter(m => m.agentVisible && (!modality || m.capabilities[modality]))
    .map(m => {
      const unit =
        m.pricing.billingUnit === "per_1k_chars"
          ? "1k chars"
          : m.pricing.billingUnit === "per_minute"
            ? "min"
            : "sec"
      const modalities = [
        m.capabilities.tts ? "TTS" : null,
        m.capabilities.stt ? "STT" : null,
        m.capabilities.s2s ? "S2S" : null,
      ]
        .filter(Boolean)
        .join("+")
      return `| \`${m.id}\` | ${modalities} | $${m.pricing.baseCost}/${unit} | ${m.description} |`
    })
    .join("\n")
}
