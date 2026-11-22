/**
 * The ONE defaults file of @agentproto/voice (AIP-VOICE, "Kit defaults").
 *
 * Every value carries its origin: the file:line it was tuned in, and the PR
 * when there is one. Paths like `calls/` and `af/` are the call pipeline and
 * agent-framework voice folders of the host product the values were tuned in.
 * Tests and code read values from here; nothing else in the package holds a
 * tuning number or a vendor model name.
 *
 * What is NOT here, on purpose (product settings that stay in the product):
 * the 550 ms silence of one deployment, wait phrases and clips, hosted-agent
 * ids, the WhatsApp call bridge, per-engine inbound rates of that bridge.
 *
 * Engine and provider defaults (decision of 2026-11-20): the default engine
 * is the cascade, with ElevenLabs for both stages (Scribe for STT). OpenAI
 * is a provider among others. A deployment can keep STT on OpenAI file
 * transcription by setting `VOICE_STT_PROVIDER=whisper`. That is a value it
 * sets itself: the kit default changes, no value changes meaning.
 */

export interface Origin<T> {
  value: T
  /** studio file:line, PR or decision that fixed the value. */
  origin: string
}

const d = <T>(value: T, origin: string): Origin<T> => ({ value, origin })

export const VOICE_DEFAULTS = {
  selection: {
    /** Default engine when `VOICE_PROVIDER` is unset. */
    engine: d<"cascade" | "realtime">(
      "cascade",
      "Decision of Jeremy, 2026-11-20: the default engine is the ElevenLabs cascade",
    ),
    /** Default provider slug of each stage when no slug is given. */
    stt: d("elevenlabs", "Decision of Jeremy, 2026-11-20: Scribe streaming"),
    tts: d("elevenlabs", "Decision of Jeremy, 2026-11-20"),
    realtime: d(
      "elevenlabs",
      "Decision of Jeremy, 2026-11-20: hosted speech-to-speech agent, reached with VOICE_PROVIDER=elevenlabs-s2s",
    ),
  },

  /**
   * Session-level defaults. Only the cascade consumes `idleMicMs` today (the
   * realtime/S2S engines ignore it). Mic-idle comes from the
   * studio voice server: a session whose mic went quiet costs money per
   * second on some vendor sockets, so the kit closes it and tells the host.
   */
  session: {
    /** Close the session after this long without an inbound mic frame. 0 keeps it open forever. */
    idleMicMs: d(
      60_000,
      "af/start-voice-server.ts:1888 MIC_IDLE_PAUSE_MS: close the socket after 60 s of muted mic (some vendors bill the open second, not the turn)",
    ),
  },

  cascade: {
    vad: {
      silenceEndMs: d(
        700,
        "calls/pipeline.ts:160-172 DEFAULT_SILENCE_MS (PR #1279). A deployment may calibrate lower; that value stays in the deployment",
      ),
      rmsSilenceThreshold: d(500, "calls/pipeline.ts:164 RMS_SILENCE_THRESHOLD (int16)"),
      maxUtteranceMs: d(30_000, "calls/pipeline.ts:162 DEFAULT_MAX_UTTERANCE_MS"),
      preRollMs: d(300, "calls/pipeline.ts:172 DEFAULT_PRE_ROLL_MS"),
      blipQuietMs: d(400, "calls/pipeline.ts:168-171 BLIP_QUIET_MS"),
    },
    bargeIn: {
      enabled: d(true, "calls/call-tuning.ts:16-21"),
      minSpeechMs: d(300, "calls/pipeline.ts:176 DEFAULT_BARGE_IN_MS (PR #1220)"),
      guardMs: d(500, "calls/pipeline.ts:178 DEFAULT_BARGE_IN_GUARD_MS"),
      rms: d(1000, "calls/pipeline.ts:165 DEFAULT_BARGE_IN_RMS (about -30 dBFS)"),
      gapMs: d(80, "calls/pipeline.ts:180 BARGE_IN_GAP_MS"),
    },
    playback: {
      outboundQueueMaxMs: d(2500, "calls/call-tuning.ts:3-6 (PR #1220)"),
      backpressureGraceMs: d(5000, "calls/pipeline.ts:184 BACKPRESSURE_GRACE_MS"),
      settleGraceMs: d(3000, "calls/pipeline.ts:183 PLAYBACK_SETTLE_GRACE_MS"),
      queueIdleMs: d(20, "calls/pipeline.ts QUEUE_IDLE_MS"),
    },
    brain: {
      firstChunkMs: d(12_000, "calls/brain-turn.ts:19"),
      idleMs: d(20_000, "calls/brain-turn.ts:20"),
      cancelTimeoutMs: d(5_000, "calls/brain-turn.ts:58"),
      turnTimeoutMs: d(120_000, "calls/pipeline.ts:163 DEFAULT_TURN_TIMEOUT_MS"),
    },
    stt: {
      finalTimeoutMs: d(2000, "calls/stt-stream.ts:146 (PR #1227)"),
      /** Three-guard transcript dedup: values only; see cascade/stt-dedup.ts. */
      dedup: {
        /** Identical normalized transcripts inside this window are dropped. */
        duplicateWindowMs: d(
          5000,
          "af/turn-runner.ts:32,64 DEDUPE_WINDOW_MS (VAD splits on an inhale, partial + final double-fire)",
        ),
        /** Window in which a transcript may match what the assistant just said. */
        echoWindowMs: d(10_000, "af/turn-runner.ts:61 ECHO_WINDOW_MS (own TTS bouncing back through the mic)"),
        /** Share of tokens (>= minTokenLength) that must match to call it an echo. */
        echoOverlapRatio: d(0.6, "af/turn-runner.ts:89-112: 60 % covers truncated echoes without flagging genuine replies"),
        /** Tokens shorter than this never count for the echo overlap. */
        minTokenLength: d(3, "af/turn-runner.ts:76-78: short words never identify an echo"),
      },
    },
    audio: {
      inboundSampleRate: d(16_000, "calls/pipeline.ts:237"),
      outboundSampleRate: d(24_000, "calls/pipeline.ts:238; af/tts-providers.ts:20"),
    },
  },

  tts: {
    /**
     * Turn-level TTS mode. `http-sentence`: one TTS request per sentence.
     * `ws-continuous`: one vendor stream per reply fed the raw brain text
     * (server-side chunking, no per-sentence handshake), with the fallback
     * to `http-sentence` bounded by `continuous` below. Kept on `http-sentence`
     * until `ws-continuous` is validated on a real call. Env:
     * `VOICE_TTS_MODE` (see `ttsModeFromEnv`).
     */
    mode: d<"http-sentence" | "ws-continuous">(
      "http-sentence",
      "voice/env.ts:60-62 VOICE_TTS_MODE (PR #1226)",
    ),
    /**
     * Per-sentence TTS transport. `stream`: the provider's streaming socket
     * when it has one (ElevenLabs `stream-input` WS, ~200-400 ms less TTFB per
     * sentence). `http`: opt-out that forces one-shot synthesis so an
     * operator can kill a flaky socket without redeploying. Env:
     * `VOICE_TTS_TRANSPORT` (see `ttsTransportFromEnv`).
     */
    transport: d<"stream" | "http">(
      "stream",
      "af/start-voice-server.ts:2095 VOICE_TTS_TRANSPORT: the WS unless the operator sets http",
    ),
    split: {
      minSentenceChars: d(12, "af/sentence-pipeliner.ts:54 (PR #1114)"),
      firstClauseMinChars: d(24, "af/sentence-pipeliner.ts:39-45,55 (PR #1114)"),
    },
    continuous: {
      openTimeoutMs: d(1500, "calls/stream-turn.ts:41-63; af/tts-providers.ts:164 (PR #1226)"),
      stallTimeoutMs: d(2500, "calls/stream-turn.ts:308 (PR #1226)"),
      drainIdleTimeoutMs: d(3000, "calls/stream-turn.ts:309 (PR #1226)"),
      /** Text that must be waiting before the mute watchdog arms. */
      firstAudioArmChars: d(100, "calls/stream-turn.ts:66"),
      midTurnArmChars: d(320, "calls/stream-turn.ts:67"),
      /** Estimate of voiced text from delivered audio (replay boundary). */
      audioBytesPerSecond: d(48_000, "calls/stream-turn.ts:74 (pcm16 24 kHz mono)"),
      slowSpeechCharsPerSecond: d(12, "calls/stream-turn.ts:75"),
    },
  },

  /**
   * Per-provider defaults, consumed by the `@agentproto/voice-<slug>`
   * packages (step 4b). Data only: nothing in this package calls a vendor.
   */
  providers: {
    elevenlabs: {
      ttsModel: d("eleven_flash_v2_5", "af/voice-provider-factory.ts:43"),
      outputFormat: d("pcm_24000", "af/voice-provider-factory.ts:47; af/tts-providers.ts:22-23"),
      stability: d(0.5, "af/voice-provider-factory.ts:45"),
      style: d(0, "af/voice-provider-factory.ts:46"),
      similarityBoost: d(0.75, "af/tts-providers.ts:324-329"),
      useSpeakerBoost: d(true, "af/tts-providers.ts:324-329"),
      vadThreshold: d(0.5, "af/voice-provider-factory.ts:44"),
      sttModel: d("scribe_v2_realtime", "calls/stt-stream.ts:145 (PR #1227)"),
      sttFileModel: d("scribe_v1", "ElevenLabs speech-to-text API; accepted by the live API when the voice-elevenlabs fixtures were recorded (2026-11-21)"),
      chunkLengthSchedule: d([80, 120, 200, 290] as readonly number[], "af/tts-providers.ts:56-72 (PR #1226)"),
      /** A premade public voice of the vendor, not an account object. */
      voiceId: d("21m00Tcm4TlvDq8ikWAM", "af/start-voice-server.ts:647-648"),
    },
    openai: {
      realtimeModel: d("gpt-realtime", "integration/mastra openai-realtime-ga.adapter.ts:31"),
      realtimeVoice: d("alloy", "openai-realtime-ga.adapter.ts:32"),
      realtimeVad: d(
        { type: "server_vad", threshold: 0.5, silenceMs: 700 } as const,
        "openai-realtime-ga.adapter.ts:229-236",
      ),
      realtimeInputTranscription: d("whisper-1", "openai-realtime-ga.adapter.ts:228"),
      realtimeSampleRate: d(24_000, "openai-realtime-ga.adapter.ts:227,239"),
      sttFileModel: d("whisper-1", "calls/transcribe.ts:43"),
      ttsModel: d("gpt-4o-mini-tts", "af/voice/preview.ts:90 (OPENAI_TTS_MODEL default)"),
      ttsVoice: d("alloy", "af/strategies/engines.ts:100-295; same default voice family as realtimeVoice"),
      /** The speech API's `pcm` response format is PCM16 mono 24 kHz. */
      ttsSampleRate: d(24_000, "api.openai.com audio/speech response_format=pcm, read 2026-11-21"),
    },
    gemini: {
      liveModel: d(
        "gemini-3.1-flash-live-preview",
        "af/strategies/engines.ts:189. The model catalog's google/gemini-live entry settled on the same id in step 4b (model-catalog/src/audio/catalog.ts): its old value was a TTS-only model the Live API cannot run",
      ),
      voice: d("Aoede", "af/strategies/engines.ts:190,268"),
      sampleRate: d(24_000, "integration/mastra gemini-live.adapter.ts:56"),
    },
    assemblyai: {
      /** Omit `speech_model`: the server default of the day (streaming docs, 2026-11-21). Pin it to override. */
      sttSpeechModel: d<string | undefined>(
        undefined,
        "assemblyai.com/docs/streaming/api-spec/streaming-websocket, read 2026-11-21: omit speech_model for the server default",
      ),
      /** `encoding` sent with the binary audio frames; PCM16 is the kit's boundary format. */
      sttEncoding: d("pcm_s16le", "assemblyai.com/docs/streaming, read 2026-11-21"),
      /** TTS-1 model id, as the server reports it in Begin.configuration.model. */
      ttsModel: d("assemblyai-tts-1", "assemblyai.com/docs/tts, read 2026-11-21"),
      /** Left out: the default voice of the language (TTS docs, 2026-11-21). */
      ttsVoiceId: d<string | undefined>(undefined, "assemblyai.com/docs/tts/connect-parameters, read 2026-11-21"),
      /** Omitted: the vendor default. A product's language is a product setting (`VOICE_LANGUAGE`), not a kit default. */
      ttsLanguage: d<string | undefined>(
        undefined,
        "PR #2804 review: no deployment language in kit defaults; assemblyai.com/docs/tts, read 2026-11-21",
      ),
      /** Native rate of TTS-1; matches the cascade outbound rate (cascade.audio.outboundSampleRate). */
      ttsSampleRate: d(24_000, "assemblyai.com/docs/tts, read 2026-11-21; defaults.ts cascade.audio.outboundSampleRate"),
      ttsEncoding: d("pcm_s16le", "assemblyai.com/docs/tts, read 2026-11-21"),
      /**
       * File transcription is the v2 REST API (upload, then transcript).
       * Omitted: the vendor default. A product's language is a product setting (`VOICE_LANGUAGE`), not a kit default.
       */
      sttFileLanguageCode: d<string | undefined>(
        undefined,
        "PR #2804 review: no deployment language in kit defaults; assemblyai.com/docs/speech-to-text, read 2026-11-21",
      ),
    },
  },

  /**
   * Data only, no consumer in this package yet: the values a future
   * WebRTC/RTP transport package reads (the transport of the studio call
   * bridge; WhatsApp-specific rows stay in the product). Listed so the
   * tuning lives in this one file when that package exists.
   */
  transport: {
    webrtc: {
      /** Opus decodes/encodes at 48 kHz whatever the PCM rate; resampled at the edges. */
      opusSampleRate: d(48_000, "af/transports/webrtc.ts:13 OPUS_RATE"),
      frameMs: d(20, "af/transports/webrtc.ts:14 FRAME_MS (960 samples at 48 kHz)"),
      payloadType: d(111, "af/transports/webrtc.ts:16 OPUS_PAYLOAD_TYPE (standard Opus PT)"),
      opusBitrate: d(32_000, "af/transports/webrtc.ts:43 opusBitrate default (bit/s)"),
      /** `audio` = CELT, waveform-faithful; `voip` = SILK, lower rate. */
      opusApplication: d<"audio" | "voip">("audio", "af/transports/webrtc.ts:63-64,151-158"),
      /** PCM edge conversion between the session rate and the Opus rate. */
      resampler: d<"windowed-sinc">("windowed-sinc", "af/transports/pcm-resampler.ts; webrtc.ts:556-562"),
      /** Safety cap on queued outbound audio. A speech-to-speech reply arrives faster than real time. */
      maxOutboundQueueMs: d(
        120_000,
        "af/transports/webrtc.ts:65-71 maxOutboundQueueMs: a long reply fits, a runaway producer hits the cap",
      ),
    },
  },

  /**
   * Data only: the model-catalog id billed for each vendor's hosted
   * speech-to-speech product, for a usage registry that accounts per
   * engine (the kit itself reports the model actually run). Same ids as
   * the studio billing mapping.
   */
  billing: {
    s2sModel: {
      openai: d("openai/gpt-realtime", "af/strategies/engines.ts:100; catalog id of the GA realtime model"),
      elevenlabs: d("elevenlabs/conversational", "af/strategies/engines.ts:148; catalog id of Conversational AI"),
      gemini: d("google/gemini-live", "af/strategies/engines.ts:200,295; catalog id of the Live API"),
    },
  },
} as const

/** The standard environment variable names (AIP-VOICE, Variables). */
export const VOICE_ENV = {
  provider: "VOICE_PROVIDER",
  sttProvider: "VOICE_STT_PROVIDER",
  ttsProvider: "VOICE_TTS_PROVIDER",
  voiceId: "VOICE_ID",
  language: "VOICE_LANGUAGE",
} as const
