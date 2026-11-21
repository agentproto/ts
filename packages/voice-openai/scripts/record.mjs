#!/usr/bin/env node
/**
 * Record real OpenAI exchanges into src/__tests__/fixtures/ (a few cents of
 * API usage: one short TTS clip, reused for Whisper and the Realtime session).
 * Needs OPENAI_API_KEY in the environment. Nothing is printed that contains
 * the key. The fixtures are redacted (audio cut, identifiers replaced) before
 * they are written; the fixture test scans them again.
 *
 *   OPENAI_API_KEY=... pnpm --filter @agentproto/voice-openai build && \
 *   node packages/voice-openai/scripts/record.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"
import { makeOpenAIRealtime, makeOpenAIStt, makeOpenAITts, wavFromPcm16 } from "../dist/index.mjs"
import { redactExchange } from "@agentproto/voice/testing"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "..", "src", "__tests__", "fixtures")
mkdirSync(out, { recursive: true })
const key = process.env.OPENAI_API_KEY
if (!key) throw new Error("OPENAI_API_KEY is not set")
const today = new Date().toISOString().slice(0, 10)
const TEXT = "Bonjour, ceci est un test de la voix."
const PROMPT = "Tu es un assistant vocal de test."

function recordingSocket(frames, urlBox) {
  return (url, init) => {
    urlBox.url = url
    const ws = new WebSocket(url, init?.headers ? { headers: init.headers } : undefined)
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

function recordingFetch(box) {
  return async (url, init) => {
    const res = await fetch(url, init)
    const buf = Buffer.from(await res.clone().arrayBuffer())
    const ct = res.headers.get("content-type") ?? undefined
    let reqBody
    if (typeof init?.body === "string") { try { reqBody = JSON.parse(init.body) } catch { reqBody = init.body } }
    else if (init?.body instanceof FormData) reqBody = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"]))
    else if (init?.body instanceof Uint8Array) reqBody = `<binary:${init.body.byteLength} bytes>`
    box.ex = {
      kind: "http", provider: "openai", recordedAt: today,
      request: { method: init?.method ?? "GET", url: String(url), body: reqBody },
      response: ct?.includes("json") ? { status: res.status, body: JSON.parse(buf.toString()), contentType: ct } : { status: res.status, bodyBase64: buf.toString("base64"), contentType: ct },
    }
    return res
  }
}

const save = (name, ex) => {
  // "delta" is an audio key in the Realtime wire protocol (both directions);
  // its text deltas are short enough to never hit the cut.
  const redacted = redactExchange(ex, { truncateAudioTo: 96, extraAudioKeys: ["delta"] })
  writeFileSync(join(out, `${name}.json`), JSON.stringify(redacted, null, 2) + "\n")
  console.log("wrote", name)
}
const wait = ms => new Promise(r => setTimeout(r, ms))

// 1. TTS over HTTP (the audio the STT and realtime fixtures reuse).
let box = {}
const tts = makeOpenAITts({ apiKey: key, fetch: recordingFetch(box) })
const spoken = await tts.synthesize({ text: TEXT })
console.log("tts http bytes:", spoken.bytes.byteLength, "duration:", spoken.durationSeconds)
save("tts-http", box.ex)

// 2. Whisper over HTTP (file), from the WAV-wrapped TTS audio.
{
  const b = {}
  const stt = makeOpenAIStt({ apiKey: key, fetch: recordingFetch(b) })
  const r = await stt.transcribe({ bytes: wavFromPcm16(spoken.bytes, 24000), mimeType: "audio/wav" }, { language: "fr" })
  console.log("whisper text:", JSON.stringify(r.text))
  save("stt-file", b.ex)
}

// 3. Realtime session over the WebSocket: one full turn (server VAD commits
//    after the audio ends), then close.
{
  const frames = [], urlBox = {}
  const rt = makeOpenAIRealtime({ apiKey: key, socket: recordingSocket(frames, urlBox) })
  const events = []
  const session = await rt.start({
    emit: {
      audio: () => events.push("audio"),
      userTranscript: (t, f) => events.push(["user", t, f]),
      assistantTranscript: (t, f) => events.push(["assistant", t, f]),
      toolCallStart: () => {}, toolCallEnd: () => {},
      interrupt: () => events.push("interrupt"),
      responseComplete: () => events.push("complete"),
      error: e => console.error("realtime error:", e.message),
    },
    hooks: { getSystemPrompt: async () => PROMPT },
  })
  const done = new Promise(resolve => {
    const poll = setInterval(() => {
      if (events.includes("complete")) { clearInterval(poll); resolve() }
    }, 100)
    setTimeout(() => { clearInterval(poll); resolve() }, 40000)
  })
  const pcm = Buffer.from(spoken.bytes)
  const step = 24000 * 2 / 10 // 100 ms
  for (let i = 0; i < pcm.length; i += step) {
    const chunk = pcm.subarray(i, i + step)
    session.pushAudio({ pcm16: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength), sampleRate: 24000, sequenceNumber: i })
    await wait(50)
  }
  await wait(1000)
  await session.commit() // explicit commit: requests the reply now
  await done
  console.log("realtime events:", JSON.stringify(events).slice(0, 200))
  await session.close()
  await wait(200)
  save("realtime-ws", { kind: "ws", provider: "openai", url: urlBox.url, recordedAt: today, frames })
}

// No barge-in fixture is recorded: two real attempts (talk over the
// assistant once the audio deltas start) each ended in a completed response,
// because server VAD only fires a cancelling speech_started when the new
// speech arrives while the response is still active, and the short test turn
// finishes before the burst lands. The interrupted conformance case therefore
// runs on scripted protocol frames in the test, from the wire described in
// realtime.ts; this recorder stops at the full turn.
