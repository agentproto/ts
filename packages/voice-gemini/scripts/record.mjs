#!/usr/bin/env node
/**
 * Record a real Gemini Live exchange into src/__tests__/fixtures/ (a few
 * cents of API usage). Needs GEMINI_API_KEY (else GOOGLE_API_KEY) in the
 * environment. Nothing is printed that contains the key.
 *
 * The spoken input is first synthesized with the Gemini TTS generateContent
 * endpoint (the record-time TTS model id, overridable with
 * GEMINI_RECORD_TTS_MODEL), then replayed into a Live session through the
 * provider itself, so the recorded wire is exactly what the provider sends.
 *
 * The fixtures are redacted (audio fields and the `key` URL parameter cut or
 * replaced) before they are written; the fixture test scans them again.
 *
 *   pnpm --filter @agentproto/voice-gemini build && \
 *   node packages/voice-gemini/scripts/record.mjs
 *
 * No barge-in fixture is recorded: the Live API runs here with its automatic
 * VAD off (the production wire this provider replicates), so the server never
 * interrupts by itself in this mode, and the manual `interrupt()` is a pure
 * client-side playback cut with nothing to observe on the wire. The
 * interrupted conformance case therefore runs on scripted protocol frames in
 * the test, from the wire described in live.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"
import { makeGeminiLive, resolveGeminiKey } from "../dist/index.mjs"
import { redactExchange } from "@agentproto/voice/testing"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "..", "src", "__tests__", "fixtures")
mkdirSync(out, { recursive: true })
const key = resolveGeminiKey({})
const today = new Date().toISOString().slice(0, 10)
const TEXT = "Bonjour, ceci est un test de la voix."
const PROMPT = "Tu es un assistant vocal de test."
const TTS_MODEL = process.env.GEMINI_RECORD_TTS_MODEL ?? "gemini-2.5-flash-preview-tts"
const wait = ms => new Promise(r => setTimeout(r, ms))

// 1. Synthesize the spoken input with the Gemini TTS endpoint (PCM16 24 kHz).
async function synthesize() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Dis: ${TEXT}` }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } } },
    }),
  })
  if (!res.ok) throw new Error(`gemini tts: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  const part = body.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data)
  if (!part) throw new Error("gemini tts: no audio part in the response")
  return { base64: part.inlineData.data, mimeType: part.inlineData.mimeType }
}

// 2. One Live session through the provider, wrapped in a recording socket.
function recordingSocket(frames, urlBox) {
  return (url) => {
    urlBox.url = url
    const ws = new WebSocket(url)
    const cbs = { open: [], message: [], error: [], close: [] }
    ws.on("open", () => cbs.open.forEach(cb => cb()))
    ws.on("message", d => {
      const s = d.toString()
      let data = s
      try { data = JSON.parse(s) } catch {}
      frames.push({ dir: "in", data })
      cbs.message.forEach(cb => cb(s))
    })
    ws.on("error", e => cbs.error.forEach(cb => cb(e)))
    ws.on("close", c => cbs.close.forEach(cb => cb(c)))
    return {
      send(data) {
        const s = typeof data === "string" ? data : Buffer.from(data).toString("base64")
        let parsed = s
        try { parsed = JSON.parse(s) } catch {}
        frames.push({ dir: "out", data: parsed })
        ws.send(data)
      },
      close: c => ws.close(c),
      on: (e, cb) => cbs[e].push(cb),
    }
  }
}

const spoken = await synthesize()
console.log("tts bytes:", Math.round((spoken.base64.length * 3) / 4))

const frames = []
const urlBox = {}
const rt = makeGeminiLive({ socket: recordingSocket(frames, urlBox) })
const events = []
const session = await rt.start({
  emit: {
    audio: () => events.push("audio"),
    userTranscript: (t, f) => events.push(["user", t, f]),
    assistantTranscript: (t, f) => events.push(["assistant", t, f]),
    toolCallStart: () => {}, toolCallEnd: () => {},
    interrupt: () => events.push("interrupt"),
    responseComplete: () => events.push("complete"),
    error: e => console.error("live error:", e.message),
  },
  hooks: { getSystemPrompt: async () => PROMPT },
})
await wait(300) // setupComplete: the server acknowledges the setup message

const pcm = Buffer.from(spoken.base64, "base64")
const step = 24000 * 2 / 10 // 100 ms
for (let i = 0; i < pcm.length; i += step) {
  const chunk = pcm.subarray(i, i + step)
  session.pushAudio({ pcm16: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength), sampleRate: 24000, sequenceNumber: i })
  await wait(50)
}
await session.commit() // activityEnd: requests the reply now
const done = new Promise(resolve => {
  const poll = setInterval(() => {
    if (events.includes("complete")) { clearInterval(poll); resolve() }
  }, 100)
  setTimeout(() => { clearInterval(poll); resolve() }, 60000)
})
await done
console.log("live events:", JSON.stringify(events).slice(0, 300))
await session.close()
await wait(200)

// "data" is the audio key on this wire (in both directions); "key" in the URL
// is a credential parameter, redacted on its own.
const redacted = redactExchange(
  { kind: "ws", provider: "gemini", url: urlBox.url, recordedAt: today, frames },
  { truncateAudioTo: 96, extraAudioKeys: ["data"] },
)
writeFileSync(join(out, "live-ws.json"), JSON.stringify(redacted, null, 2) + "\n")
console.log("wrote live-ws.json")
