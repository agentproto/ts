#!/usr/bin/env node
/**
 * Record real ElevenLabs exchanges into src/__tests__/fixtures/ (a few cents of
 * API usage). Needs ELEVENLABS_API_KEY in the environment. Nothing is printed
 * that contains the key. The fixtures are redacted (audio cut, identifiers
 * replaced) before they are written; the fixture test scans them again.
 *
 *   ELEVENLABS_API_KEY=... pnpm --filter @agentproto/voice-elevenlabs build && \
 *   node packages/voice-elevenlabs/scripts/record.mjs
 *
 * The hosted speech-to-speech agent is not recorded here: it needs an agent of
 * your own account (set ELEVENLABS_RECORD_AGENT_ID); without it that fixture
 * is skipped.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"
import { createElevenLabsProvider, makeElevenLabsRealtime, makeElevenLabsStt, makeElevenLabsTts } from "../dist/index.mjs"
import { redactExchange } from "@agentproto/voice/testing"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "..", "src", "__tests__", "fixtures")
mkdirSync(out, { recursive: true })
const key = process.env.ELEVENLABS_API_KEY
if (!key) throw new Error("ELEVENLABS_API_KEY is not set")
const today = new Date().toISOString().slice(0, 10)

/** A socket factory that records every frame in both directions. */
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
    box.ex = {
      kind: "http", provider: "elevenlabs", recordedAt: today,
      request: { method: init?.method ?? "GET", url: String(url).replace(/[?&](xi-api-key|key)=[^&]*/g, ""), body: reqBody },
      response: ct?.includes("json") ? { status: res.status, body: JSON.parse(buf.toString()), contentType: ct } : { status: res.status, bodyBase64: buf.toString("base64"), contentType: ct },
    }
    return res
  }
}

const save = (name, ex) => {
  const redacted = redactExchange(ex, { truncateAudioTo: 96 })
  writeFileSync(join(out, `${name}.json`), JSON.stringify(redacted, null, 2) + "\n")
  console.log("wrote", name)
}
const wait = ms => new Promise(r => setTimeout(r, ms))

// 1. TTS over HTTP (also the audio the STT fixtures reuse).
let box = {}
const ttsHttp = makeElevenLabsTts({ apiKey: key, fetch: recordingFetch(box) })
const spoken = await ttsHttp.synthesize({ text: "Bonjour, ceci est un test de la voix." })
save("tts-http", box.ex)

// 2. TTS over the stream-input WebSocket.
{
  const frames = [], urlBox = {}
  const tts = makeElevenLabsTts({ apiKey: key, socket: recordingSocket(frames, urlBox) })
  const stream = await tts.openStream({})
  await new Promise(resolve => {
    stream.on("done", resolve)
    stream.on("error", e => { console.error("tts ws error:", e.message); resolve() })
    stream.sendText("Bonjour, ")
    stream.sendText("ceci est un test.")
    stream.end()
  })
  await stream.close()
  save("tts-ws", { kind: "ws", provider: "elevenlabs", url: urlBox.url, recordedAt: today, frames })
}

// 3. STT over HTTP (file), from the audio just synthesized.
{
  const b = {}
  const stt = makeElevenLabsStt({ apiKey: key, fetch: recordingFetch(b) })
  const r = await stt.transcribe({ bytes: spoken.bytes, mimeType: "audio/pcm", sampleRate: 24000 })
  console.log("stt file text:", JSON.stringify(r.text))
  save("stt-file", b.ex)
}

// 4. STT over the realtime WebSocket, same audio, manual commit.
{
  const frames = [], urlBox = {}
  const stt = makeElevenLabsStt({ apiKey: key, socket: recordingSocket(frames, urlBox) })
  const stream = await stt.openStream({ sampleRate: 24000 })
  const got = await new Promise(resolve => {
    const t = setTimeout(() => resolve("<timeout>"), 15000)
    stream.on("final", x => { clearTimeout(t); resolve(x.text) })
    stream.on("error", e => { clearTimeout(t); resolve("<error " + e.message + ">") })
    const pcm = Buffer.from(spoken.bytes)
    const step = 24000 * 2 / 5 // 200 ms
    ;(async () => {
      for (let i = 0; i < pcm.length; i += step) {
        const chunk = pcm.subarray(i, i + step)
        stream.pushAudio({ pcm16: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength), sampleRate: 24000, sequenceNumber: i })
        await wait(20)
      }
      await wait(200)
      stream.commit()
    })()
  })
  console.log("stt ws final:", JSON.stringify(got))
  await stream.close()
  save("stt-ws", { kind: "ws", provider: "elevenlabs", url: urlBox.url, recordedAt: today, frames })
}

// 5. Hosted agent (optional).
const agentId = process.env.ELEVENLABS_RECORD_AGENT_ID
if (agentId) {
  const frames = [], urlBox = {}
  const rt = makeElevenLabsRealtime({ apiKey: key, socket: recordingSocket(frames, urlBox) })
  const events = []
  const session = await rt.start({
    emit: { audio: () => events.push("audio"), userTranscript: () => {}, assistantTranscript: () => {}, toolCallStart() {}, toolCallEnd() {}, interrupt() {}, responseComplete: () => events.push("complete"), error: e => console.error(e.message) },
    hooks: {},
    provider: { agentId },
  })
  await wait(1500)
  await session.pushText("Dis bonjour en une phrase.")
  await wait(8000)
  await session.close()
  save("agent-ws", { kind: "ws", provider: "elevenlabs", url: urlBox.url, recordedAt: today, frames })
} else console.log("agent: skipped (set ELEVENLABS_RECORD_AGENT_ID to record it)")
void createElevenLabsProvider
