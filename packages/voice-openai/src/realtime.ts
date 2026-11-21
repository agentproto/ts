/**
 * OpenAI Realtime API (GA) as a `RealtimeProvider`: one WebSocket per
 * session, server VAD, native barge-in.
 *
 * Wire protocol (GA, as run in production by the studio,
 * `integration/mastra openai-realtime-ga.adapter.ts`):
 *   - URL:    `wss://api.openai.com/v1/realtime?model=<model>`
 *   - Auth:   `Authorization: Bearer <key>` (no Beta header since GA)
 *   - Setup:  `session.update` with the GA `session.audio.{input,output}`
 *             shape; `session.created` is the ready signal.
 *   - Up:     `input_audio_buffer.append {audio: base64}`,
 *             `input_audio_buffer.commit`, `response.create`,
 *             `response.cancel` + `input_audio_buffer.clear` (interrupt),
 *             `conversation.item.create` (text or function_call_output).
 *   - Down:   `response.audio.delta`, `response.audio_transcript.delta`,
 *             `response.done` (`response.usage`, `status: "cancelled"` on a
 *             barge-in), `conversation.item.input_audio_transcription.completed`,
 *             `input_audio_buffer.speech_started`, `error`.
 */
import {
  VOICE_DEFAULTS,
  type AudioFrame,
  type RealtimeProvider,
  type VoiceEmit,
  type VoiceSession,
  type VoiceStartOptions,
  type VoiceTokenBuckets,
  type VoiceUsage,
  makeUsageMeter,
} from "@agentproto/voice"
import { DEFAULT_WS_BASE_URL, nodeSocketFactory, type OpenAITransport } from "./transport.js"
import { resolveApiKey } from "./stt.js"

const D = VOICE_DEFAULTS.providers.openai

export interface OpenAIRealtimeConfig extends OpenAITransport {
  apiKey?: string | (() => string | undefined)
  modelId?: string
  voiceId?: string
  /** `VOICE_PROVIDER` value that selects this engine. */
  id?: string
}

interface ServerEvent {
  type: string
  [key: string]: unknown
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)

export function makeOpenAIRealtime(cfg: OpenAIRealtimeConfig = {}): RealtimeProvider {
  const model = () => cfg.modelId ?? D.realtimeModel.value
  const voice = () => cfg.voiceId ?? D.realtimeVoice.value
  const rate = D.realtimeSampleRate.value

  return {
    slug: "openai",
    capabilities: {
      id: cfg.id ?? "openai-realtime",
      serverVad: true,
      interruption: true,
      functionCalling: true,
      say: false,
      refreshTools: true,
      languages: [],
      // The session is pinned to `rate` frames (session.update below) and
      // pushAudio forwards bytes without resampling: only the session rate
      // is accepted as input.
      inputSampleRates: [rate],
      outputSampleRate: rate,
    },

    async start(opts: VoiceStartOptions): Promise<VoiceSession> {
      const apiKey = resolveApiKey(cfg)
      const socketFactory = cfg.socket ?? nodeSocketFactory
      const { emit, hooks } = opts
      const url = `${cfg.wsBaseUrl ?? DEFAULT_WS_BASE_URL}/v1/realtime?model=${model()}`
      const meter = makeUsageMeter("realtime")

      let systemPrompt: string | undefined
      try {
        systemPrompt = await hooks.getSystemPrompt?.()
      } catch {
        systemPrompt = undefined
      }
      let tools: Awaited<ReturnType<NonNullable<typeof hooks.getTools>>> | undefined
      try {
        tools = await hooks.getTools?.()
      } catch {
        tools = undefined
      }

      let closed = false
      let isOpen = false
      let seq = 0
      let responseActive = false
      let bargeIn = false
      let interruptEmitted = false
      let assistantText = ""
      // Whether the response in flight actually spoke (audio or transcript):
      // a tool-call-only response did not.
      let responseSpoke = false
      // Both response.function_call_arguments.done and the response.done output
      // walk report the same call; dispatch each call_id exactly once.
      const dispatchedCalls = new Set<string>()
      const pending: string[] = []
      const sock = socketFactory(url, { headers: { Authorization: `Bearer ${apiKey}` } })
      // Like the studio adapter: frames go out as soon as the socket is open;
      // session.update is sent first, the server processes it before the audio.
      const send = (obj: unknown) => {
        const s = JSON.stringify(obj)
        if (isOpen) sock.send(s)
        else pending.push(s)
      }

      const sessionUpdate = () => {
        const vad = D.realtimeVad.value
        const session: Record<string, unknown> = {
          type: "realtime",
          model: model(),
          ...(systemPrompt ? { instructions: systemPrompt } : {}),
          audio: {
            input: {
              format: { type: "audio/pcm", rate },
              transcription: { model: D.realtimeInputTranscription.value, ...(opts.language ? { language: opts.language } : {}) },
              turn_detection: { type: vad.type, threshold: vad.threshold, silence_duration_ms: vad.silenceMs },
            },
            output: { format: { type: "audio/pcm", rate }, voice: voice() },
          },
        }
        if (tools && tools.length > 0) {
          session.tools = tools.map(t => ({ type: "function", name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters }))
          session.tool_choice = "auto"
        }
        return { type: "session.update", session }
      }

      sock.on("open", () => {
        isOpen = true
        sock.send(JSON.stringify(sessionUpdate()))
        for (const s of pending.splice(0)) sock.send(s)
      })
      sock.on("message", data => {
        if (closed) return
        let ev: ServerEvent
        try {
          ev = JSON.parse(data)
        } catch (err) {
          emit.error(err as Error)
          return
        }
        switch (ev.type) {
          case "session.created":
          case "session.updated": {
            break
          }
          case "response.created": {
            responseActive = true
            bargeIn = false
            interruptEmitted = false
            assistantText = ""
            responseSpoke = false
            break
          }
          case "response.audio.delta":
          case "response.output_audio.delta": {
            if (bargeIn) break
            const delta = str(ev.delta)
            if (delta) {
              responseSpoke = true
              const bytes = Buffer.from(delta, "base64")
              const even = bytes.byteLength - (bytes.byteLength % 2)
              if (even > 0) {
                meter.addRealtime("openai", { audioSeconds: even / 2 / rate }, model())
                emit.audio({ pcm16: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even) as ArrayBuffer, sampleRate: rate, sequenceNumber: seq++ })
              }
            }
            break
          }
          case "response.audio_transcript.delta":
          case "response.output_audio_transcript.delta": {
            // A cut turn is cut whole: no transcript after the audio stopped.
            if (bargeIn) break
            const delta = str(ev.delta)
            if (delta) {
              responseSpoke = true
              assistantText += delta
              emit.assistantTranscript(delta, false)
            }
            break
          }
          case "conversation.item.input_audio_transcription.completed": {
            const text = str(ev.transcript)
            if (text) {
              emit.userTranscript(text, true)
              void hooks.onTranscript?.({ role: "user", text, finalizedAt: Date.now() })?.catch(() => undefined)
            }
            break
          }
          case "input_audio_buffer.speech_started": {
            // Server VAD: the user started talking while a response is in
            // flight; the server cancels that response (barge-in).
            if (responseActive && !bargeIn) {
              bargeIn = true
              interruptEmitted = true
              emit.interrupt()
            }
            break
          }
          case "response.done": {
            const response = (ev.response ?? {}) as { status?: string; usage?: Record<string, unknown>; output?: unknown[] }
            if (response.usage) meter.addRealtime("openai", { tokens: usageToBuckets(response.usage) }, model())
            const outputs = Array.isArray(response.output) ? response.output : []
            for (const out of outputs) {
              if (typeof out === "object" && out !== null && (out as { type?: string }).type === "function_call") {
                void dispatchToolCall(out as { call_id: string; name: string; arguments: string })
              }
            }
            responseActive = false
            const hadFunctionCall = outputs.some(out => (out as { type?: string }).type === "function_call")
            if (response.status === "cancelled") {
              // Barge-in or manual response.cancel: the turn was cut.
              if (!interruptEmitted) {
                interruptEmitted = true
                emit.interrupt()
              }
            } else if (responseSpoke || !hadFunctionCall) {
              emit.assistantTranscript(assistantText, true)
              void hooks.onTranscript?.({ role: "assistant", text: assistantText, finalizedAt: Date.now() })?.catch(() => undefined)
              emit.responseComplete()
            }
            // else: a tool-call-only response did not complete the assistant
            // turn: responseComplete fires exactly once per uninterrupted
            // turn, from the response that speaks after the tool result.
            assistantText = ""
            responseSpoke = false
            bargeIn = false
            break
          }
          case "response.function_call_arguments.done": {
            const callId = str(ev.call_id)
            if (callId) void dispatchToolCall({ call_id: callId, name: str(ev.name) ?? "", arguments: str(ev.arguments) ?? "{}" })
            break
          }
          case "error": {
            const err = (ev.error ?? {}) as { message?: string }
            emit.error(new Error(`openai realtime: ${err.message ?? "error"}`))
            break
          }
          default:
            break
        }
      })
      sock.on("error", err => {
        if (!closed) emit.error(err)
      })
      sock.on("close", () => {
        closed = true
      })

      async function dispatchToolCall(call: { call_id: string; name: string; arguments: string }) {
        if (closed || !call.name) return
        if (call.call_id && dispatchedCalls.has(call.call_id)) return
        if (call.call_id) dispatchedCalls.add(call.call_id)
        let args: unknown
        try {
          args = JSON.parse(call.arguments || "{}")
        } catch (err) {
          emit.toolCallEnd(call.name, { error: (err as Error).message })
          send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "bad_arguments" }) } })
          send({ type: "response.create" })
          return
        }
        emit.toolCallStart(call.name, args)
        try {
          const result = (await hooks.onToolCall?.(call.name, args)) ?? null
          emit.toolCallEnd(call.name, result)
          send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: call.call_id, output: typeof result === "string" ? result : JSON.stringify(result) },
          })
          send({ type: "response.create" })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          emit.toolCallEnd(call.name, { error: msg })
          send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: msg }) },
          })
          send({ type: "response.create" })
        }
      }

      const session: VoiceSession = {
        engine: "realtime",
        capabilities: {
          serverVad: true,
          interruption: true,
          functionCalling: true,
          say: false,
          languages: [],
        },
        pushAudio(frame: AudioFrame) {
          if (closed) return
          meter.addRealtime("openai", { audioSeconds: frame.pcm16.byteLength / 2 / frame.sampleRate }, model())
          send({ type: "input_audio_buffer.append", audio: Buffer.from(frame.pcm16).toString("base64") })
        },
        async commit() {
          if (closed) return
          send({ type: "input_audio_buffer.commit" })
          send({ type: "response.create" })
        },
        async interrupt() {
          if (closed) return
          const wasActive = responseActive
          if (wasActive && !interruptEmitted) {
            interruptEmitted = true
            bargeIn = true
            emit.interrupt()
          }
          // Only cancel a response that is actually in flight: an idle cancel
          // makes the server answer with an `error` event.
          responseActive = false
          if (wasActive) send({ type: "response.cancel" })
          send({ type: "input_audio_buffer.clear" })
        },
        async pushText(text: string) {
          if (closed) return
          send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } })
          send({ type: "response.create" })
        },
        async refreshTools() {
          if (closed) return
          try {
            tools = await hooks.getTools?.()
          } catch {
            tools = undefined
          }
          systemPrompt = undefined
          try {
            systemPrompt = await hooks.getSystemPrompt?.()
          } catch {
            systemPrompt = undefined
          }
          send(sessionUpdate())
        },
        getUsage: (): VoiceUsage => meter.snapshot(),
        async close() {
          if (closed) {
            meter.seal()
            return
          }
          closed = true
          meter.seal()
          sock.close(1000)
        },
      }
      return session
    },
  }
}

/** Map the Realtime `response.usage` object onto the kit's token buckets. */
function usageToBuckets(usage: Record<string, unknown>): Partial<VoiceTokenBuckets> {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
  const inputDetails = (usage.input_token_details ?? {}) as Record<string, unknown>
  const outputDetails = (usage.output_token_details ?? {}) as Record<string, unknown>
  // GA shape: `input_token_details.cached_tokens` is the NUMBER of cached
  // tokens; the audio/text breakdown lives under `cached_tokens_details`.
  const cachedDetails = (inputDetails.cached_tokens_details ?? {}) as Record<string, unknown>
  const audioIn = num(inputDetails.audio_tokens) ?? 0
  const audioOut = num(outputDetails.audio_tokens) ?? 0
  const inputTokens = num(usage.input_tokens) ?? 0
  const outputTokens = num(usage.output_tokens) ?? 0
  const cachedAudioIn = num(cachedDetails.audio_tokens) ?? 0
  const cachedTextIn = num(cachedDetails.text_tokens) ?? 0
  return {
    audioIn,
    audioOut,
    textIn: Math.max(0, inputTokens - audioIn - cachedAudioIn),
    textOut: Math.max(0, outputTokens - audioOut),
    cachedAudioIn,
    cachedTextIn,
  }
}
