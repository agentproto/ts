/**
 * ElevenLabs hosted speech-to-speech agent as a `RealtimeProvider`.
 *
 * The agent (its prompt, voice, LLM, turn settings) is an object of the
 * caller's ElevenLabs account. It is passed in `VoiceStartOptions.provider`:
 *
 *   { agentId: string }     the agent to talk to (a key is then required), or
 *   { signedUrl: string }   a signed conversation URL (no key on the socket).
 *
 * Optional `overrides: { llm?, ttsModelId? }` travel only when set, and only
 * work if the agent allows them in its settings. No account identifier lives
 * in this package.
 *
 * Wire protocol (as run in production by the studio, `integration/speech`
 * `conversational.provider.ts`): `user_audio_chunk` up; `audio`,
 * `user_transcript`, `agent_response`, `interruption`, `ping`/`pong`,
 * `client_tool_call`/`client_tool_result` both ways.
 */
import {
  type AudioFrame,
  type RealtimeProvider,
  type VoiceSession,
  type VoiceStartOptions,
  type VoiceUsage,
  makeUsageMeter,
} from "@agentproto/voice"
import { DEFAULT_WS_BASE_URL, nodeSocketFactory, type ElevenLabsTransport } from "./transport.js"
import { resolveApiKey } from "./tts.js"

export interface ElevenLabsRealtimeConfig extends ElevenLabsTransport {
  apiKey?: string | (() => string | undefined)
  /** `VOICE_PROVIDER` value that selects this engine. */
  id?: string
}

export interface ElevenLabsAgentOptions {
  agentId?: string
  signedUrl?: string
  overrides?: { llm?: string; ttsModelId?: string }
  dynamicVariables?: Record<string, unknown>
}

function rateOfFormat(fmt: string | undefined, fallback: number): number {
  const m = fmt ? /^pcm_(\d+)$/.exec(fmt) : null
  return m ? Number(m[1]) : fallback
}

export function makeElevenLabsRealtime(cfg: ElevenLabsRealtimeConfig = {}): RealtimeProvider {
  return {
    slug: "elevenlabs",
    capabilities: {
      id: cfg.id ?? "elevenlabs-s2s",
      serverVad: true,
      interruption: true,
      functionCalling: true,
      say: false,
      refreshTools: false,
      languages: [],
      inputSampleRates: [16000],
      outputSampleRate: 16000,
    },

    async start(opts: VoiceStartOptions): Promise<VoiceSession> {
      const agent = (opts.provider ?? {}) as ElevenLabsAgentOptions
      if (!agent.signedUrl && !agent.agentId) {
        throw new Error("elevenlabs realtime: VoiceStartOptions.provider needs { agentId } or { signedUrl }")
      }
      const socketFactory = cfg.socket ?? nodeSocketFactory
      const url = agent.signedUrl ?? `${cfg.wsBaseUrl ?? DEFAULT_WS_BASE_URL}/v1/convai/conversation?agent_id=${agent.agentId}`
      const headers = agent.signedUrl ? undefined : { "xi-api-key": resolveApiKey(cfg) }
      const { emit, hooks } = opts
      const meter = makeUsageMeter("realtime")
      let outRate = 16000
      let closed = false
      let seq = 0
      let lastInterruptEventId = 0
      let isOpen = false
      const pending: string[] = []
      const sock = socketFactory(url, headers ? { headers } : undefined)
      const send = (obj: unknown) => {
        const s = JSON.stringify(obj)
        if (isOpen) sock.send(s)
        else pending.push(s)
      }

      const init: Record<string, unknown> = { type: "conversation_initiation_client_data", dynamic_variables: agent.dynamicVariables ?? {} }
      const override: Record<string, unknown> = {}
      const prompt: Record<string, unknown> = {}
      void hooks.getSystemPrompt?.().then(p => p && (prompt.prompt = p)).catch(() => undefined)
      if (agent.overrides?.llm) prompt.llm = agent.overrides.llm
      if (opts.voiceId || agent.overrides?.ttsModelId) {
        override.tts = { ...(opts.voiceId ? { voice_id: opts.voiceId } : {}), ...(agent.overrides?.ttsModelId ? { model_id: agent.overrides.ttsModelId } : {}) }
      }
      if (Object.keys(prompt).length) override.agent = { prompt }
      if (Object.keys(override).length) init.conversation_config_override = override

      sock.on("open", () => {
        isOpen = true
        sock.send(JSON.stringify(init))
        for (const s of pending.splice(0)) sock.send(s)
      })

      sock.on("message", data => {
        if (closed) return
        let m: Record<string, any>
        try {
          m = JSON.parse(data)
        } catch (err) {
          emit.error(err as Error)
          return
        }
        switch (m.type) {
          case "conversation_initiation_metadata":
            outRate = rateOfFormat(m.conversation_initiation_metadata_event?.agent_output_audio_format, outRate)
            break
          case "ping":
            send({ type: "pong", event_id: m.ping_event?.event_id })
            break
          case "audio": {
            const eventId = m.audio_event?.event_id
            // Chunks of an interrupted reply can still be in flight.
            if (typeof eventId === "number" && eventId < lastInterruptEventId) break
            const b64: string | undefined = m.audio_event?.audio_base_64
            if (!b64) break
            const bytes = Buffer.from(b64, "base64")
            const even = bytes.byteLength - (bytes.byteLength % 2)
            if (even === 0) break
            const frame: AudioFrame = { pcm16: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even) as ArrayBuffer, sampleRate: outRate, sequenceNumber: seq++ }
            meter.addRealtime("elevenlabs", { audioSeconds: even / 2 / outRate })
            emit.audio(frame)
            break
          }
          case "user_transcript": {
            const text: string = m.user_transcription_event?.user_transcript ?? ""
            emit.userTranscript(text, true)
            void hooks.onTranscript?.({ role: "user", text, finalizedAt: Date.now() })?.catch(() => undefined)
            break
          }
          case "agent_response": {
            const text: string = m.agent_response_event?.agent_response ?? ""
            emit.assistantTranscript(text, true)
            void hooks.onTranscript?.({ role: "assistant", text, finalizedAt: Date.now() })?.catch(() => undefined)
            emit.responseComplete()
            break
          }
          case "interruption": {
            const id = m.interruption_event?.event_id
            if (typeof id === "number") lastInterruptEventId = Math.max(lastInterruptEventId, id)
            emit.interrupt()
            break
          }
          case "client_tool_call": {
            const call = m.client_tool_call as { tool_call_id: string; tool_name: string; parameters: unknown }
            emit.toolCallStart(call.tool_name, call.parameters)
            void (async () => {
              try {
                const result = (await hooks.onToolCall?.(call.tool_name, call.parameters)) ?? null
                emit.toolCallEnd(call.tool_name, result)
                send({ type: "client_tool_result", tool_call_id: call.tool_call_id, result: typeof result === "string" ? result : JSON.stringify(result), is_error: false })
              } catch (err) {
                // A failed tool call goes back to the model, not into the session.
                const msg = err instanceof Error ? err.message : String(err)
                emit.toolCallEnd(call.tool_name, { error: msg })
                send({ type: "client_tool_result", tool_call_id: call.tool_call_id, result: msg, is_error: true })
              }
            })()
            break
          }
          default:
            break
        }
      })
      sock.on("error", err => !closed && emit.error(err))
      sock.on("close", () => {
        closed = true
      })

      return {
        engine: "realtime",
        capabilities: { serverVad: true, interruption: true, functionCalling: true, say: false, languages: [] },
        pushAudio(frame) {
          if (closed) return
          meter.addRealtime("elevenlabs", { audioSeconds: frame.pcm16.byteLength / 2 / frame.sampleRate })
          send({ user_audio_chunk: Buffer.from(frame.pcm16).toString("base64") })
        },
        async commit() {},
        async interrupt() {
          // The hosted agent detects turns and barge-in itself; a manual cut is a
          // user activity signal, which makes the agent yield the floor.
          if (!closed) send({ type: "user_activity" })
        },
        async pushText(text: string) {
          if (!closed) send({ type: "user_message", text })
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
    },
  }
}
