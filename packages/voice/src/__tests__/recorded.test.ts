import { describe, expect, it } from "vitest"
import { makeReplayFetch, makeReplaySocket, redactExchange, redactUrlCredentials, scanForSecrets, type RecordedHttpExchange, type RecordedWsExchange } from "../testing/recorded.js"

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
  it("flags header names, bearer tokens, vendor-style keys, long hex, exact values, unredacted ids and url credentials", () => {
    expect(scanForSecrets('{"xi-api-key":"x"}')).toContain("api-key header name")
    expect(scanForSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwx")).not.toEqual([])
    expect(scanForSecrets("sk-abcdefghijklmnopqrstuvwxyz")).toContain("openai-style key")
    expect(scanForSecrets("0123456789abcdef0123456789abcdef")).toContain("long hex secret")
    expect(scanForSecrets("hello value-1234567890 world", ["value-1234567890"])).toContain("exact secret value")
    expect(scanForSecrets('{"conversation_id":"conv_abc"}')).toContain("unredacted identifier field")
    expect(scanForSecrets('{"conversation_id":"<redacted>","text":"salut"}')).toEqual([])
    // A credential left in a url query is caught; the redaction output is not.
    expect(scanForSecrets("https://x.test/v1?token=abc123XYZ")).toContain("credential in url query")
    expect(scanForSecrets("https://x.test/v1?token=<redacted>")).toEqual([])
  })
})

describe("redactUrlCredentials", () => {
  it("redacts every credential parameter and keeps the other query intact", () => {
    expect(redactUrlCredentials("wss://x.test/v1?model_id=m&token=abc123&key=k9")).toBe(
      "wss://x.test/v1?model_id=m&token=<redacted>&key=<redacted>",
    )
    expect(redactUrlCredentials("https://x.test/p?api_key=SECRET")).toBe("https://x.test/p?api_key=<redacted>")
    expect(redactUrlCredentials("https://x.test/p")).toBe("https://x.test/p")
  })
})

describe("redactExchange on an http exchange", () => {
  it("redacts credentials from the request url too, not only from bodies", () => {
    const ex: RecordedHttpExchange = {
      kind: "http",
      provider: "acme",
      recordedAt: "2026-11-21",
      request: {
        method: "POST",
        url: "https://example.test/v1/tts?api_key=SECRETVALUE&agent_id=ag_42&voice_id=v1",
        body: { text: "bonjour", session_id: "sess-9" },
      },
      response: { status: 200, body: { request_id: "req-1", audio_base64: "A".repeat(500) } },
    }
    const r = redactExchange(ex, { truncateAudioTo: 16 })
    expect(r.request.url).toBe("https://example.test/v1/tts?api_key=<redacted>&agent_id=<redacted>&voice_id=v1")
    expect(JSON.stringify(r)).not.toContain("SECRETVALUE")
    expect(JSON.stringify(r)).not.toContain("ag_42")
    expect(JSON.stringify(r)).not.toContain("sess-9")
    expect(JSON.stringify(r)).not.toContain("req-1")
    expect((r.response.body as { audio_base64: string }).audio_base64).toHaveLength(16)
    expect(scanForSecrets(JSON.stringify(r))).toEqual([])
    // The input is untouched.
    expect(ex.request.url).toContain("SECRETVALUE")
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

describe("makeReplaySocket interleaved frames", () => {
  it("delivers a recorded in-frame that sits between two out frames sent in the same tick", async () => {
    const ex: RecordedWsExchange = {
      kind: "ws",
      provider: "acme",
      url: "wss://example.test/stream",
      recordedAt: "2026-11-21",
      frames: [
        { dir: "out", data: { n: 1 } },
        { dir: "in", data: { type: "mid", text: "x" } },
        { dir: "out", data: { n: 2 } },
        { dir: "in", data: { type: "final", text: "y" } },
      ],
    }
    const r = makeReplaySocket(ex)
    const sock = r.factory(ex.url)
    const got: string[] = []
    sock.on("message", d => got.push(d))
    await new Promise<void>(res => sock.on("open", () => res()))
    expect(got).toEqual([])
    // Both sends in the same tick: the in-frame recorded between them must not be skipped.
    sock.send(JSON.stringify({ n: 1 }))
    sock.send(JSON.stringify({ n: 2 }))
    await Promise.resolve()
    await Promise.resolve()
    expect(got.map(g => JSON.parse(g).text)).toEqual(["x", "y"])
    expect(r.mismatches).toEqual([])
    expect(r.done()).toBe(true)
  })

  it("masks only the audio keys it is given: a generic data key is compared verbatim unless passed as extraAudioKeys", async () => {
    const ex: RecordedWsExchange = {
      kind: "ws",
      provider: "acme",
      url: "wss://example.test/stream",
      recordedAt: "2026-11-21",
      frames: [{ dir: "out", data: { data: "not audio, a real payload", audio: "A".repeat(500) } }],
    }
    const strict = makeReplaySocket(ex)
    const s = strict.factory(ex.url)
    await new Promise<void>(res => s.on("open", () => res()))
    s.send(JSON.stringify({ data: "not audio, a real payload", audio: "different audio" }))
    // "data" is compared verbatim and matches; "audio" is masked by presence.
    expect(strict.mismatches).toEqual([])
    const different = makeReplaySocket(ex)
    const s2 = different.factory(ex.url)
    await new Promise<void>(res => s2.on("open", () => res()))
    s2.send(JSON.stringify({ data: "changed payload", audio: "whatever" }))
    expect(different.mismatches).toHaveLength(1)
    expect(different.mismatches[0]).toMatch(/differs/)
    // With extraAudioKeys, "data" is treated as audio and masked.
    const extra = makeReplaySocket(ex, { extraAudioKeys: ["data"] })
    const s3 = extra.factory(ex.url)
    await new Promise<void>(res => s3.on("open", () => res()))
    s3.send(JSON.stringify({ data: "anything at all", audio: "x" }))
    expect(extra.mismatches).toEqual([])
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

  it("matches a redacted fixture url against the live url, credential parameter in any position", async () => {
    const recorded = redactExchange({
      kind: "http",
      provider: "acme",
      recordedAt: "2026-11-21",
      request: { method: "GET", url: "https://example.test/v1/voices?key=REALSECRET&show_legacy=true" },
      response: { status: 200, body: { voices: [] } },
    } satisfies RecordedHttpExchange)
    expect(recorded.request.url).toBe("https://example.test/v1/voices?key=<redacted>&show_legacy=true")
    const { fetch: f } = makeReplayFetch([recorded])
    // Credential first, mid-query and last all match the redacted fixture.
    expect((await f("https://example.test/v1/voices?key=REALSECRET&show_legacy=true")).status).toBe(200)
    expect((await f("https://example.test/v1/voices?show_legacy=true&key=REALSECRET")).status).toBe(200)
    expect((await f("https://example.test/v1/voices?show_legacy=true&agent_id=ag9&key=REALSECRET")).status).toBe(200)
    // A different query still fails loudly.
    expect((await f("https://example.test/v1/voices?show_legacy=false")).status).toBe(599)
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
