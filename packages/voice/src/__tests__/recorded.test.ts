import { describe, expect, it } from "vitest"
import { makeReplayFetch, makeReplaySocket, redactExchange, scanForSecrets, type RecordedHttpExchange, type RecordedWsExchange } from "../testing/recorded.js"

const ws: RecordedWsExchange = {
  kind: "ws",
  provider: "acme",
  url: "wss://example.test/v1/stream?model_id=m&token=abc123",
  recordedAt: "2026-11-21",
  frames: [
    { dir: "in", data: { type: "hello", session_id: "sess-real-123" } },
    { dir: "out", data: { audio: "A".repeat(500), commit: true } },
    { dir: "in", data: { type: "final", text: "bonjour" } },
  ],
}

describe("redactExchange", () => {
  it("cuts audio, replaces identifiers and strips credentials from the url, without mutating the input", () => {
    const r = redactExchange(ws, { truncateAudioTo: 16 })
    expect(JSON.stringify(r)).not.toContain("sess-real-123")
    expect(JSON.stringify(r)).not.toContain("abc123")
    expect((r.frames[1]!.data as { audio: string }).audio).toHaveLength(16)
    expect(r.audioTruncatedTo).toBe(16)
    expect(JSON.stringify(ws)).toContain("sess-real-123")
    expect(scanForSecrets(JSON.stringify(r))).toEqual([])
  })
})

describe("scanForSecrets", () => {
  it("flags header names, bearer tokens, vendor-style keys, long hex, exact values and unredacted ids", () => {
    expect(scanForSecrets('{"xi-api-key":"x"}')).toContain("api-key header name")
    expect(scanForSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwx")).not.toEqual([])
    expect(scanForSecrets("sk-abcdefghijklmnopqrstuvwxyz")).toContain("openai-style key")
    expect(scanForSecrets("0123456789abcdef0123456789abcdef")).toContain("long hex secret")
    expect(scanForSecrets("hello value-1234567890 world", ["value-1234567890"])).toContain("exact secret value")
    expect(scanForSecrets('{"conversation_id":"conv_abc"}')).toContain("unredacted identifier field")
    expect(scanForSecrets('{"conversation_id":"<redacted>","text":"salut"}')).toEqual([])
  })
})

describe("makeReplaySocket", () => {
  it("delivers in frames after the matching out frame, and reports a different out frame", async () => {
    const r = makeReplaySocket(ws)
    const sock = r.factory(ws.url)
    const got: string[] = []
    sock.on("message", d => got.push(d))
    await new Promise<void>(res => sock.on("open", () => res()))
    await Promise.resolve()
    expect(got).toHaveLength(1)
    sock.send(JSON.stringify({ audio: "different audio payload", commit: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(got).toHaveLength(2)
    expect(JSON.parse(got[1]!).text).toBe("bonjour")
    expect(r.mismatches).toEqual([])
    expect(r.done()).toBe(true)
    const r2 = makeReplaySocket(ws)
    const s2 = r2.factory(ws.url)
    await new Promise<void>(res => s2.on("open", () => res()))
    s2.send(JSON.stringify({ audio: "x", commit: false }))
    expect(r2.mismatches[0]).toMatch(/differs/)
  })
})

describe("makeReplayFetch", () => {
  const ex: RecordedHttpExchange = {
    kind: "http", provider: "acme", recordedAt: "2026-11-21",
    request: { method: "POST", url: "https://example.test/v1/tts" },
    response: { status: 200, bodyBase64: Buffer.from("pcm").toString("base64"), contentType: "audio/pcm" },
  }
  it("answers from the recording and notes the request; an unknown request fails loudly", async () => {
    const { fetch: f, requests } = makeReplayFetch([ex])
    const ok = await f("https://example.test/v1/tts", { method: "POST", body: JSON.stringify({ text: "x" }) })
    expect(ok.status).toBe(200)
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("pcm")
    expect(requests[0]!.body).toEqual({ text: "x" })
    expect((await f("https://example.test/other")).status).toBe(599)
  })
})

describe("makeReplaySocket lenient mode", () => {
  it("accepts any out frame and delivers the recorded in frames once releaseWhen is true", async () => {
    const r = makeReplaySocket(ws, { releaseWhen: f => f.commit === true })
    const sock = r.factory(ws.url)
    const got: string[] = []
    sock.on("message", d => got.push(d))
    await new Promise<void>(res => sock.on("open", () => res()))
    await Promise.resolve()
    sock.send(JSON.stringify({ something: "else" }))
    expect(got).toHaveLength(0)
    sock.send(JSON.stringify({ commit: true }))
    expect(got).toHaveLength(2)
    expect(r.mismatches).toEqual([])
  })
})
