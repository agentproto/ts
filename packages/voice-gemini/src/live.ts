/**
 * Google Gemini Live as a `RealtimeProvider`: one WebSocket per session over
 * the bidirectional Live API (`BidiGenerateContent`), the wire the studio runs
 * in production (`integration/mastra gemini-live.adapter.ts`, Guilde).
 *
 * Wire protocol:
 *   - URL:    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<key>`
 *             (the key rides the query, like `@google/genai`; never in a frame)
 *   - Setup:  one `setup` message first: model (`models/<id>`), generation
 *             config (response modalities AUDIO, the prebuilt voice), system
 *             instruction, input and output audio transcription, and the tool
 *             declarations; `setupComplete` is the ready signal.
 *   - Up:     `realtimeInput.audio {data: base64, mimeType: audio/pcm;rate=<n>}`,
 *             `realtimeInput.activityEnd {}` (the reply commit: the studio
 *             runs the API with its automatic VAD off, `answer()` in the
 *             adapter), `clientContent` (a typed text turn),
 *             `toolOutput.functionResponses` (a tool result).
 *   - Down:   `serverContent.modelTurn.parts[].inlineData` (audio),
 *             `serverContent.{input,output}Transcription {text, finished}`,
 *             `serverContent.interrupted`, `serverContent.turnComplete`,
 *             `toolCall.functionCalls`, `setupComplete`, `usageMetadata`.
 *
 * Interruption: the Live API has no client-side "cancel the response" frame;
 * the kit's `interrupt()` cuts the playback client-side (one `interrupt`
 * event, then no further audio for that turn) and a new reply starts from the
 * next `commit()`. `serverContent.interrupted` (what the API sends when it
 * cuts the turn itself, in its automatic-VAD mode) maps to the same event.
 *
 * Tools are frozen at setup on the Live wire (there is no session.update);
 * `refreshTools()` reconnects the session with a fresh setup, mirroring the
 * adapter.
 */
import {
  VOICE_DEFAULTS,
  type AudioFrame,
  type RealtimeProvider,
  type VoiceSession,
  type VoiceSocket,
  type VoiceSocketFactory,
  type VoiceStartOptions,
  type VoiceTokenBuckets,
  makeUsageMeter,
} from "@agentproto/voice"
import { BIDI_PATH, DEFAULT_WS_BASE_URL, nodeSocketFactory } from "./transport.js"

const D = VOICE_DEFAULTS.providers.gemini

export interface GeminiLiveConfig {
  /** Read lazily at each call: `GEMINI_API_KEY`, else `GOOGLE_API_KEY`. */
  apiKey?: string | (() => string | undefined)
  modelId?: string
  voiceId?: string
  /** Default: the `ws` package factory of this package. */
  socket?: VoiceSocketFactory
  /** Default: `wss://generativelanguage.googleapis.com`. */
  wsBaseUrl?: string
}

/** Read the key lazily, at each call: `GEMINI_API_KEY`, else `GOOGLE_API_KEY`. */
export function resolveGeminiKey(cfg: { apiKey?: string | (() => string | undefined) }): string {
  const given = typeof cfg.apiKey === "function" ? cfg.apiKey() : cfg.apiKey
  const k = given ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (!k) throw new Error("gemini: no API key (set GEMINI_API_KEY)")
  return k
}

interface ServerMessage {
  [key: string]: unknown
}

interface FunctionCall {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)

export function makeGeminiLive(cfg: GeminiLiveConfig = {}): RealtimeProvider {
  const model = () => cfg.modelId ?? D.liveModel.value
  const voice = () => cfg.voiceId ?? D.voice.value
  const rate = D.sampleRate.value

  return {
    slug: "gemini",
    capabilities: {
      id: "gemini-live",
      serverVad: false,
      interruption: true,
      functionCalling: true,
      say: false,
      refreshTools: true,
      languages: [],
      inputSampleRates: [16_000, rate],
      outputSampleRate: rate,
    },

    async start(opts: VoiceStartOptions): Promise<VoiceSession> {
      const apiKey = resolveGeminiKey(cfg)
      const { emit, hooks } = opts
      const socketFactory = cfg.socket ?? nodeSocketFactory
      const url = `${cfg.wsBaseUrl ?? DEFAULT_WS_BASE_URL}${BIDI_PATH}?key=${apiKey}`
      const meter = makeUsageMeter("realtime")

      let systemPrompt = await readPrompt(hooks)
      let tools = await readTools(hooks)

      const setupFrame = () => ({
        setup: {
          model: `models/${model()}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice() } } },
          },
          // Both transcriptions, like the production adapter: the user's mic
          // and the assistant's voice, so transcripts persist on both sides.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
          ...(tools && tools.length > 0
            ? {
                tools: [
                  {
                    functionDeclarations: tools.map(t => ({
                      name: t.name,
                      ...(t.description ? { description: t.description } : {}),
                      // Lowercase JSON Schema: the `parameters` field wants
                      // uppercase OpenAPI types, `parametersJsonSchema` does not.
                      parametersJsonSchema: t.parameters,
                    })),
                  },
                ],
              }
            : {}),
        },
      })

      let closed = false
      let turnOpen = false // a model turn (audio) is in flight
      let interrupted = false // playback was cut: drop the rest of the turn
      let interruptEmitted = false
      let seq = 0
      let userText = ""
      let assistantText = ""
      const pending: string[] = []

      /** The socket wrapper, with its own open flag; setup goes out first. */
      const attach = (): OpenableSock => {
        const sock = socketFactory(url)
        let open = false
        const wrapper: OpenableSock = {
          sock,
          isOpen: () => open,
          close: code => {
            open = false
            sock.close(code)
          },
          handleOpen: () => {
            open = true
            sock.send(JSON.stringify(setupFrame())) // the setup frame leads
            for (const s of pending.splice(0)) sock.send(s)
          },
        }
        sock.on("open", () => wrapper.handleOpen())
        sock.on("message", data => handle(String(data)))
        sock.on("error", err => {
          if (!closed) emit.error(err as Error)
        })
        sock.on("close", () => {
          open = false
        })
        return wrapper
      }

      interface OpenableSock {
        sock: VoiceSocket
        isOpen(): boolean
        close(code?: number): void
        handleOpen(): void
      }

      let current = attach()

      const send = (obj: unknown) => {
        const s = JSON.stringify(obj)
        if (closed) return
        if (current.isOpen()) current.sock.send(s)
        else pending.push(s)
      }

      const flushUserTurn = () => {
        // The API frequently never sends `inputTranscription.finished`, so the
        // user turn finalizes like the adapter does: at the first sign of the
        // assistant replying, or at turnComplete.
        if (!userText) return
        emit.userTranscript(userText, true)
        void hooks.onTranscript?.({ role: "user", text: userText, finalizedAt: Date.now() })?.catch(() => undefined)
        userText = ""
      }
      const finishAssistantTurn = () => {
        flushUserTurn()
        if (assistantText) {
          emit.assistantTranscript(assistantText, true)
          void hooks.onTranscript?.({ role: "assistant", text: assistantText, finalizedAt: Date.now() })?.catch(() => undefined)
          assistantText = ""
        }
        emit.responseComplete()
        turnOpen = false
        interrupted = false
        interruptEmitted = false
      }

      async function dispatchFunctionCall(call: FunctionCall) {
        if (closed || !call.name) return
        emit.toolCallStart(call.name, call.args)
        let response: Record<string, unknown>
        try {
          const result = (await hooks.onToolCall?.(call.name, call.args)) ?? null
          emit.toolCallEnd(call.name, result)
          response = normalizeFunctionResponse(result)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          emit.toolCallEnd(call.name, { error: message })
          response = { error: message }
        }
        send({ toolOutput: { functionResponses: [{ id: call.id ?? "", name: call.name, response }] } })
      }

      const handle = (raw: string) => {
        if (closed) return
        let msg: ServerMessage
        try {
          msg = JSON.parse(raw)
        } catch (err) {
          emit.error(err as Error)
          return
        }
        if (msg.setupComplete !== undefined) return
        if (msg.usageMetadata) {
          const u = msg.usageMetadata as Record<string, unknown>
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
          // Gemini reports undifferentiated token counts for a bidi turn (no
          // audio/text split on this wire), so they land in the text buckets.
          const tokens: Partial<VoiceTokenBuckets> = {
            textIn: num(u.promptTokenCount),
            textOut: num(u.candidatesTokenCount),
            audioIn: 0,
            audioOut: 0,
            cachedAudioIn: 0,
            cachedTextIn: 0,
          }
          meter.addRealtime("gemini", { tokens }, model())
        }
        const calls = (msg.toolCall as { functionCalls?: FunctionCall[] } | undefined)?.functionCalls
        if (calls) for (const call of calls) void dispatchFunctionCall(call)
        const sc = msg.serverContent as
          | {
              modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string; functionCall?: unknown }> }
              inputTranscription?: { text?: string; finished?: boolean }
              outputTranscription?: { text?: string; finished?: boolean }
              turnComplete?: boolean
              interrupted?: boolean
            }
          | undefined
        if (!sc) return
        // One serverContent can carry several fields (the adapter reads them
        // side by side), so every field is processed, none short-circuits.
        if (sc.interrupted) {
          if (turnOpen && !interruptEmitted) {
            interruptEmitted = true
            interrupted = true
            emit.interrupt()
          }
        }
        if (sc.modelTurn) {
          const parts = sc.modelTurn.parts ?? []
          for (const part of parts) {
            if (interrupted) break
            const data = str(part.inlineData?.data)
            if (data) {
              if (!turnOpen) {
                // The assistant started replying: the user turn is over.
                flushUserTurn()
                turnOpen = true
                interrupted = false
                interruptEmitted = false
              }
              const bytes = Buffer.from(data, "base64")
              const even = bytes.byteLength - (bytes.byteLength % 2)
              if (even > 0) {
                meter.addRealtime("gemini", { audioSeconds: even / 2 / rate }, model())
                emit.audio({ pcm16: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even) as ArrayBuffer, sampleRate: rate, sequenceNumber: seq++ })
              }
            }
            if (part.functionCall) void dispatchFunctionCall(part.functionCall as FunctionCall)
          }
        }
        const it = sc.inputTranscription
        if (it && typeof it.text === "string" && it.text) {
          userText += it.text
          emit.userTranscript(it.text, false)
        }
        if (it?.finished) flushUserTurn()
        const ot = sc.outputTranscription
        if (ot && typeof ot.text === "string" && ot.text) {
          flushUserTurn() // the assistant replying means the user has finished
          if (!interrupted) {
            assistantText += ot.text
            emit.assistantTranscript(ot.text, false)
          }
        }
        if (ot?.finished && !interrupted) emit.assistantTranscript(assistantText, true)
        if (sc.turnComplete) {
          if (!interrupted) finishAssistantTurn()
          else {
            // A turn cut mid-flight still ends: clear the cut state so the
            // session is ready for the next one, without a completion event.
            assistantText = ""
            turnOpen = false
            interrupted = false
            interruptEmitted = false
          }
        }
      }

      return {
        engine: "realtime",
        capabilities: {
          serverVad: false,
          interruption: true,
          functionCalling: true,
          say: false,
          languages: [],
        },
        pushAudio(frame: AudioFrame) {
          if (closed) return
          meter.addRealtime("gemini", { audioSeconds: frame.pcm16.byteLength / 2 / frame.sampleRate }, model())
          send({ realtimeInput: { audio: { data: Buffer.from(frame.pcm16).toString("base64"), mimeType: `audio/pcm;rate=${frame.sampleRate}` } } })
        },
        async commit() {
          if (closed) return
          send({ realtimeInput: { activityEnd: {} } })
        },
        async interrupt() {
          if (closed) return
          if (turnOpen && !interruptEmitted) {
            interruptEmitted = true
            interrupted = true
            emit.interrupt()
          }
        },
        async pushText(text) {
          if (closed) return
          send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } })
        },
        async refreshTools() {
          if (closed) return
          // The Live wire freezes tools at setup: reconnect with a fresh one,
          // like the adapter (`refreshTools` there closes and reopens).
          tools = await readTools(hooks)
          systemPrompt = await readPrompt(hooks)
          const keep = current.isOpen()
          current.close(1000)
          pending.length = 0 // the conversation restarts with the new setup
          current = attach()
          if (keep) current.handleOpen()
        },
        getUsage: () => meter.snapshot(),
        async close() {
          if (closed) {
            meter.seal()
            return
          }
          closed = true
          meter.seal()
          current.close(1000)
        },
      }
    },
  }
}

/** Gemini's FunctionResponse.response is a JSON object: wrap what is not. */
function normalizeFunctionResponse(result: unknown): Record<string, unknown> {
  if (result === null || result === undefined) return { output: null }
  if (typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>
  return { output: result }
}

async function readTools(hooks: VoiceStartOptions["hooks"]) {
  try {
    return await hooks.getTools?.()
  } catch {
    return undefined
  }
}

async function readPrompt(hooks: VoiceStartOptions["hooks"]) {
  try {
    return await hooks.getSystemPrompt?.()
  } catch {
    return undefined
  }
}
