#!/usr/bin/env node
/**
 * Record real AssemblyAI exchanges into src/__tests__/fixtures/ (a few cents
 * of API usage: one short TTS clip, reused for the STT stream and the STT
 * file). Needs ASSEMBLYAI_API_KEY in the environment. Nothing is printed
 * that contains the key. The fixtures are redacted (audio cut, identifiers
 * and upload URLs replaced) before they are written; the fixture test scans
 * them again.
 *
 *   ASSEMBLYAI_API_KEY=... pnpm --filter @agentproto/voice-assemblyai build && \
 *   node packages/voice-assemblyai/scripts/record.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"
import { createAssemblyAIProvider, makeAssemblyAIStt, makeAssemblyAITts, wavFromPcm16 } from "../dist/index.mjs"
import { redactExchange } from "@agentproto/voice/testing"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "..", "src", "__tests__", "fixtures")
mkdirSync(out, { recursive: true })
const key = process.env.ASSEMBLYAI_API_KEY
if (!key) throw new Error("ASSEMBLYAI_API_KEY is not set")
const today = new Date().toISOString().slice(0, 10)
const TEXT = "Bonjour, ceci est un test de la voix."

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
      try { data = JSON.parse(s) } catch { data = `<binary:${d.length} bytes>` }
      frames.push({ dir: "in", data })
      cbs.message.forEach(cb => cb(s))
    })
    ws.on("error", e => cbs.error.forEach(cb => cb(e)))
    ws.on("close", c => cbs.close.forEach(cb => cb(c)))
    return {
      send(data) {
        let parsed
        if (typeof data === "string") {
          try { parsed = JSON.parse(data) } catch { parsed = data }
        } else {
          parsed = `<binary:${data.byteLength ?? data.length} bytes>`
        }
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
    else if (init?.body instanceof Uint8Array) reqBody = `<binary:${init.body.byteLength} bytes>`
    box.ex = {
      kind: "http", provider: "assemblyai", recordedAt: today,
      request: { method: init?.method ?? "GET", url: String(url), body: reqBody },
      response: ct?.includes("json") ? { status: res.status, body: JSON.parse(buf.toString()), contentType: ct } : { status: res.status, bodyBase64: buf.toString("base64"), contentType: ct },
    }
    return res
  }
}

// Normalize identifiers that are not covered by redactExchange: the upload
// URL (may carry a signature) and the transcript id in a request URL.
const normalize = (text, realUploadUrl, realTranscriptId) => {
  let t = text
  if (realUploadUrl) t = t.split(realUploadUrl).join("<upload-url>")
  if (realTranscriptId) t = t.split(realTranscriptId).join("<redacted>")
  return t
}

const save = (name, ex, norm = {}) => {
  const redacted = redactExchange(JSON.parse(normalize(JSON.stringify(ex), norm.uploadUrl, norm.transcriptId)), { truncateAudioTo: 96 })
  writeFileSync(join(out, `${name}.json`), JSON.stringify(redacted, null, 2) + "\n")
  console.log("wrote", name)
}
const wait = ms => new Promise(r => setTimeout(r, ms))

// 1. TTS over HTTP (the audio the STT fixtures reuse).
let box = {}
const ttsHttp = makeAssemblyAITts({ apiKey: key, fetch: recordingFetch(box) })
const spoken = await ttsHttp.synthesize({ text: TEXT })
console.log("tts http bytes:", spoken.bytes.byteLength, "duration:", spoken.durationSeconds)
save("tts-http", box.ex)

// 2. TTS over the WebSocket.
{
  const frames = [], urlBox = {}
  const tts = makeAssemblyAITts({ apiKey: key, socket: recordingSocket(frames, urlBox) })
  const stream = await tts.openStream({})
  await new Promise(resolve => {
    const t = setTimeout(resolve, 30000)
    stream.on("done", () => { clearTimeout(t); resolve() })
    stream.on("error", e => { console.error("tts ws error:", e.message); clearTimeout(t); resolve() })
    stream.sendText("Bonjour, ")
    stream.sendText("ceci est un test.")
    stream.flush()
    stream.end()
  })
  await stream.close()
  await wait(200)
  save("tts-ws", { kind: "ws", provider: "assemblyai", url: urlBox.url, recordedAt: today, frames })
}

// 3. STT over the streaming v3 WebSocket: the TTS clip above, then ForceEndpoint.
{
  const frames = [], urlBox = {}
  const stt = makeAssemblyAIStt({ apiKey: key, socket: recordingSocket(frames, urlBox) })
  const stream = await stt.openStream({ sampleRate: 24000, language: "fr" })
  const got = await new Promise(resolve => {
    const t = setTimeout(() => resolve("<timeout>"), 30000)
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
  await wait(200)
  save("stt-ws", { kind: "ws", provider: "assemblyai", url: urlBox.url, recordedAt: today, frames })
}

// 4. STT file: upload the WAV, create the transcript, poll until completed.
{
  const norm = {}
  const wav = wavFromPcm16(spoken.bytes, 24000)
  const exs = []
  const f3 = async (url, init) => {
    const res = await fetch(url, init)
    const buf = Buffer.from(await res.clone().arrayBuffer())
    const ct = res.headers.get("content-type") ?? undefined
    let reqBody
    if (typeof init?.body === "string") { try { reqBody = JSON.parse(init.body) } catch { reqBody = init.body } }
    else if (init?.body instanceof Uint8Array) reqBody = `<binary:${init.body.byteLength} bytes>`
    exs.push({
      kind: "http", provider: "assemblyai", recordedAt: today,
      request: { method: init?.method ?? "GET", url: String(url), body: reqBody },
      response: ct?.includes("json") ? { status: res.status, body: JSON.parse(buf.toString()), contentType: ct } : { status: res.status, bodyBase64: buf.toString("base64"), contentType: ct },
    })
    return res
  }
  const stt = makeAssemblyAIStt({ apiKey: key, fetch: f3, pollMs: 300 })
  const r = await stt.transcribe({ bytes: wav, mimeType: "audio/wav" }, { language: "fr" })
  console.log("stt file text:", JSON.stringify(r.text), "duration:", r.durationSeconds)
  const upload = exs[0]
  const create = exs[1]
  const polls = exs.slice(2)
  norm.uploadUrl = upload?.response?.body?.upload_url
  norm.transcriptId = create?.response?.body?.id
  save("stt-upload", upload, norm)
  save("stt-create", create, norm)
  // Keep only the final poll (completed); the provider polls until completed.
  save("stt-poll", polls[polls.length - 1], norm)
}

void createAssemblyAIProvider
