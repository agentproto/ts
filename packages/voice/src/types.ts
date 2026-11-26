/**
 * AIP-VOICE VOICE: the three provider contracts and the voice session.
 *
 * Source of truth: the VOICE spec in agentproto/agentproto. Names and
 * rules below follow that document; a rule quoted here is quoted from it.
 *
 * No agent framework is imported here or anywhere in this package.
 */

/** Audio on every boundary: PCM16 little-endian, mono. */
export interface AudioFrame {
  pcm16: ArrayBuffer
  sampleRate: number
  /** Monotonic, preserved end to end. */
  sequenceNumber: number
}

// ── STT ─────────────────────────────────────────────────────────────

export interface SttCapabilities {
  /** `openStream` is implemented. */
  streaming: boolean
  /** `transcribe` is implemented. */
  file: boolean
  /** The stream emits partial transcripts. */
  partials: boolean
  /** The vendor decides where an utterance ends. */
  serverEndpointing: boolean
  /** `commit()` requests a final on demand. */
  manualCommit: boolean
  /** BCP-47; empty means vendor default. */
  languages: readonly string[]
  sampleRates: readonly number[]
}

export interface SttStreamOptions {
  language?: string
  sampleRate: number
  signal?: AbortSignal
}

export interface SttTranscript {
  text: string
  startMs?: number
  endMs?: number
}

export interface SttStream {
  pushAudio(frame: AudioFrame): void
  /** Ask for a final for the audio pushed so far. */
  commit(): void
  on(event: "partial" | "final", cb: (t: SttTranscript) => void): void
  on(event: "error", cb: (err: Error) => void): void
  on(event: "closed", cb: () => void): void
  close(): Promise<void>
}

export interface SttFileInput {
  bytes: Uint8Array
  /** A container type, or `audio/pcm` for raw PCM16. */
  mimeType: string
  /** REQUIRED when `mimeType` is `audio/pcm`, ignored otherwise. */
  sampleRate?: number
}

export interface SttResult {
  text: string
  language?: string
  durationSeconds?: number
}

export interface SttProvider {
  readonly slug: string
  /**
   * The vendor models the provider transcribes with, when it knows them: the
   * realtime stream and file transcription usually run different models. The
   * cascade copies the one that produced each utterance onto the STT usage
   * entry so a host can price the seconds against the model that ran.
   */
  readonly models?: { readonly stream?: string; readonly file?: string }
  readonly capabilities: SttCapabilities
  openStream(opts: SttStreamOptions): Promise<SttStream>
  transcribe(
    input: SttFileInput,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<SttResult>
}

// ── TTS ─────────────────────────────────────────────────────────────

export interface TtsCapabilities {
  streaming: boolean
  file: boolean
  /** Text may arrive in pieces on one stream. */
  chunkedInput: boolean
  /** `cancel()` stops generation at the vendor. */
  cancel: boolean
  languages: readonly string[]
  outputSampleRates: readonly number[]
}

export interface TtsStreamOptions {
  voiceId?: string
  language?: string
  sampleRate?: number
  signal?: AbortSignal
}

export interface TtsStream {
  /** Chunks of one reply, in order. */
  sendText(chunk: string): void
  /** Generate what is buffered now, keep the stream open. */
  flush(): void
  /** No more text for this reply; remaining audio is still delivered. */
  end(): void
  /** Interruption: stop now. After it returns no `audio` and no `done`. */
  cancel(): void
  on(event: "audio", cb: (frame: AudioFrame) => void): void
  on(event: "done", cb: () => void): void
  on(event: "error", cb: (err: Error) => void): void
  close(): Promise<void>
}

export interface TtsResult {
  bytes: Uint8Array
  mimeType: string
  durationSeconds?: number
}

export interface TtsProvider {
  readonly slug: string
  /**
   * The vendor model the provider synthesizes with, when it knows one. The
   * cascade copies it onto the TTS usage entry so a host can price the
   * characters against the model that actually ran.
   */
  readonly model?: string
  readonly capabilities: TtsCapabilities
  openStream(opts: TtsStreamOptions): Promise<TtsStream>
  synthesize(input: {
    text: string
    voiceId?: string
    language?: string
    signal?: AbortSignal
  }): Promise<TtsResult>
}

// ── Session ─────────────────────────────────────────────────────────

export interface VoiceToolSchema {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export interface VoiceHistoryMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** Host side, all optional. */
export interface VoiceHooks {
  getSystemPrompt?(): Promise<string>
  getTools?(): Promise<VoiceToolSchema[]>
  loadHistory?(): Promise<VoiceHistoryMessage[]>
  onToolCall?(name: string, args: unknown): Promise<unknown>
  onTranscript?(turn: {
    role: "user" | "assistant"
    text: string
    finalizedAt: number
  }): Promise<void>
  /**
   * The mic went silent for the session idle bound (defaults.ts
   * `session.idleMicMs`, 60 s) and the session closed itself: the vendor
   * socket billed by the second is gone, and the host starts a fresh
   * session when the caller speaks again. Never called when the bound is
   * disabled (`idleMicMs: 0`).
   */
  onMicIdle?(info: { idleMs: number }): void | Promise<void>
}

export interface VoiceEmit {
  audio(frame: AudioFrame): void
  userTranscript(text: string, final: boolean): void
  assistantTranscript(text: string, final: boolean): void
  toolCallStart(name: string, args: unknown): void
  toolCallEnd(name: string, result: unknown): void
  /** The assistant turn was cut by a barge-in. */
  interrupt(): void
  /** The assistant turn finished. */
  responseComplete(): void
  error(err: Error): void
}

export interface VoiceStartOptions {
  emit: VoiceEmit
  hooks: VoiceHooks
  /**
   * Receives the final usage record once, when the session closes (the same
   * content `getUsage()` returns after `close()`). A throw or a rejection is
   * swallowed: it never interrupts audio or fails the close.
   */
  onUsage?(usage: VoiceUsage): void | Promise<void>
  language?: string
  voiceId?: string
  /** Opaque, product-owned, documented by the provider package. */
  provider?: Record<string, unknown>
}

export interface VoiceSessionCapabilities {
  serverVad: boolean
  interruption: boolean
  functionCalling: boolean
  say: boolean
  languages: readonly string[]
}

export type VoiceEngineId = "realtime" | "cascade"

export interface VoiceSession {
  readonly engine: VoiceEngineId
  readonly capabilities: VoiceSessionCapabilities
  pushAudio(frame: AudioFrame): Promise<void> | void
  /** Request a reply now; no-op when the engine detects turns itself. */
  commit(): Promise<void>
  /** Cancel the current assistant turn. */
  interrupt(): Promise<void>
  pushText?(text: string): Promise<void>
  refreshTools?(): Promise<void>
  say?(directive: string): Promise<void>
  getUsage?(): VoiceUsage | undefined
  close(): Promise<void>
}

// ── Realtime ────────────────────────────────────────────────────────

export interface RealtimeCapabilities {
  /** The `VOICE_PROVIDER` value that selects it. */
  id: string
  serverVad: boolean
  interruption: boolean
  functionCalling: boolean
  say: boolean
  refreshTools: boolean
  languages: readonly string[]
  inputSampleRates: readonly number[]
  outputSampleRate: number
}

export interface RealtimeProvider {
  readonly slug: string
  readonly capabilities: RealtimeCapabilities
  start(opts: VoiceStartOptions): Promise<VoiceSession>
}

// ── Usage ───────────────────────────────────────────────────────────

export interface VoiceTokenBuckets {
  audioIn: number
  audioOut: number
  textIn: number
  textOut: number
  cachedAudioIn: number
  cachedTextIn: number
}

export interface VoiceUsageEntry {
  stage: "stt" | "tts" | "realtime"
  /** The provider slug. */
  provider: string
  /** The vendor model the stage ran, when known. */
  model?: string
  /** Seconds of audio the vendor processed. */
  audioSeconds?: number
  /** Characters sent to TTS. */
  characters?: number
  tokens?: VoiceTokenBuckets
  /** Only when the vendor itself reports a cost; never computed here. */
  reportedCostUsd?: number
  /**
   * Opaque tag the host attaches to say whose key paid for the stage (for
   * example the host's own key or one its customer supplied). The kit never
   * interprets it: it carries it from the host to the host's billing. Absent
   * when the host did not set one. Not normative in the spec.
   */
  credentialSource?: CredentialSource
}

/** An opaque, host-defined label. */
export type CredentialSource = string

/** Cumulative and monotonic; final after `close()`. No price, no content. */
export interface VoiceUsage {
  engine: VoiceEngineId
  wallSeconds: number
  entries: VoiceUsageEntry[]
}

// ── Provider declaration ────────────────────────────────────────────

export interface VoiceProviderEnv {
  /** MUST be `<SLUG>_API_KEY`. */
  apiKey: string
  /** Other names also accepted; the canonical name wins. */
  aliases?: readonly string[]
}

export interface VoiceValueAliases {
  stt?: readonly string[]
  tts?: readonly string[]
}

export interface VoiceProviderDefinition {
  slug: string
  name: string
  env: VoiceProviderEnv
  valueAliases?: VoiceValueAliases
  stt?: SttProvider
  tts?: TtsProvider
  realtime?: RealtimeProvider
}

export interface VoiceProvider {
  readonly slug: string
  readonly name: string
  readonly env: Required<VoiceProviderEnv>
  readonly valueAliases: { stt: readonly string[]; tts: readonly string[] }
  readonly stt?: SttProvider
  readonly tts?: TtsProvider
  readonly realtime?: RealtimeProvider
  readonly capabilities: {
    stt?: SttCapabilities
    tts?: TtsCapabilities
    realtime?: RealtimeCapabilities
  }
}

// ── Transport seam for provider packages ────────────────────────────

/**
 * The part of a WebSocket the provider packages use. A provider takes a
 * `VoiceSocketFactory` so tests can replay recorded vendor exchanges without
 * a network; the default factory of a provider wraps the `ws` package.
 */
export interface VoiceSocket {
  send(data: string | Uint8Array): void
  close(code?: number): void
  on(event: "open", cb: () => void): void
  on(event: "message", cb: (data: string) => void): void
  on(event: "error", cb: (err: Error) => void): void
  on(event: "close", cb: (code?: number) => void): void
}

export type VoiceSocketFactory = (
  url: string,
  init?: { headers?: Record<string, string> },
) => VoiceSocket
