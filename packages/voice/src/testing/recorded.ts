/**
 * Recorded vendor exchanges: the format, a replay WebSocket and a replay
 * `fetch`, a redaction step and a secret scanner.
 *
 * A fixture is what a provider package records once against the real API
 * (a few cents) and replays in its tests, so conformance runs offline. The
 * repository is public: a fixture holds no key, no Authorization header, no
 * account identifier. `redactExchange` removes what it knows; the scanner
 * (`scanForSecrets`) is what a test runs over every committed fixture.
 */
import type { VoiceSocket, VoiceSocketFactory } from "../types.js"

export interface WsFrame {
  dir: "out" | "in"
  /** A JSON object (parsed) or a raw string. */
  data: unknown
}

export interface RecordedWsExchange {
  kind: "ws"
  provider: string
  /** URL with the query as sent, credentials removed. */
  url: string
  recordedAt: string
  /** Base64 audio fields were cut to this many characters (size only). */
  audioTruncatedTo?: number
  frames: WsFrame[]
}

export interface RecordedHttpExchange {
  kind: "http"
  provider: string
  recordedAt: string
  request: { method: string; url: string; body?: unknown }
  response: { status: number; body?: unknown; bodyBase64?: string; contentType?: string }
}

export type RecordedExchange = RecordedWsExchange | RecordedHttpExchange

/** JSON keys whose string value is audio: compared by presence, truncated on record. */
export const AUDIO_KEYS = ["audio", "audio_base_64", "audio_base64", "user_audio_chunk", "data"] as const

const isAudioKey = (k: string) => (AUDIO_KEYS as readonly string[]).includes(k)

/** Keys whose value identifies an account, a session or a conversation. */
const IDENTIFYING_KEYS = ["session_id", "conversation_id", "agent_id", "request_id", "user_id", "id"]

function mapDeep(value: unknown, fn: (k: string, v: unknown) => unknown | undefined): unknown {
  if (Array.isArray(value)) return value.map(v => mapDeep(v, fn))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const replaced = fn(k, v)
      out[k] = replaced !== undefined ? replaced : mapDeep(v, fn)
    }
    return out
  }
  return value
}

/** Truncate audio and replace identifying values. Does not mutate the input. */
export function redactExchange<T extends RecordedExchange>(ex: T, opts: { truncateAudioTo?: number } = {}): T {
  const cut = opts.truncateAudioTo ?? 96
  const redact = (k: string, v: unknown): unknown | undefined => {
    if (typeof v === "string" && isAudioKey(k) && v.length > cut) return v.slice(0, cut)
    if (typeof v === "string" && IDENTIFYING_KEYS.includes(k)) return "<redacted>"
    return undefined
  }
  const copy = structuredClone(ex) as RecordedExchange
  if (copy.kind === "ws") {
    copy.frames = copy.frames.map(f => ({ ...f, data: mapDeep(f.data, redact) }))
    copy.audioTruncatedTo = cut
    copy.url = copy.url.replace(/([?&])(token|xi-api-key|api_key|key|agent_id)=[^&]*/g, "$1$2=<redacted>")
  } else {
    copy.request = { ...copy.request, ...(copy.request.body !== undefined ? { body: mapDeep(copy.request.body, redact) } : {}) }
    copy.response = {
      ...copy.response,
      ...(copy.response.body !== undefined ? { body: mapDeep(copy.response.body, redact) } : {}),
      ...(copy.response.bodyBase64 ? { bodyBase64: copy.response.bodyBase64.slice(0, cut) } : {}),
    }
  }
  return copy as T
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["api-key header name", /xi-api-key|x-goog-api-key|authorization\s*["':]/i],
  ["bearer token", /bearer\s+[A-Za-z0-9._-]{16,}/i],
  ["openai-style key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["elevenlabs-style key", /\bsk_[a-f0-9]{24,}/i],
  ["google api key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["long hex secret", /\b[a-f0-9]{32,}\b/i],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

/**
 * Findings in `text` that look like a credential or an account identifier.
 * `knownSecrets` are exact values to look for (for example the live env keys);
 * pass whatever the recording process had in its environment.
 */
export function scanForSecrets(text: string, knownSecrets: readonly string[] = []): string[] {
  const hits: string[] = []
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) hits.push(name)
  for (const s of knownSecrets) if (s.length >= 8 && text.includes(s)) hits.push("exact secret value")
  // Identifying fields must be redacted.
  const idRe = new RegExp(`"(${IDENTIFYING_KEYS.join("|")})"\\s*:\\s*"(?!<redacted>)[^"]+"`)
  if (idRe.test(text)) hits.push("unredacted identifier field")
  return hits
}

// ── Replay ──────────────────────────────────────────────────────────

const maskAudio = (v: unknown): unknown =>
  mapDeep(v, (k, val) => (typeof val === "string" && isAudioKey(k) ? "<audio>" : undefined))

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(maskAudio(a)) === JSON.stringify(maskAudio(b))

export interface ReplaySocketResult {
  factory: VoiceSocketFactory
  /** Mismatches between what the provider sent and what was recorded. */
  mismatches: string[]
  /** URLs the provider connected to. */
  urls: string[]
  /** True when every recorded frame was consumed. */
  done: () => boolean
}

/**
 * A `VoiceSocketFactory` that plays back `exchange`: `in` frames are delivered
 * as soon as every earlier `out` frame has been sent by the provider and
 * matched (audio compared by presence only). `strictOut: false` accepts any
 * `out` frame (use it when a provider's keepalive or timing legitimately
 * differs); mismatches are always reported.
 */
export function makeReplaySocket(exchange: RecordedWsExchange, opts: { strictOut?: boolean } = {}): ReplaySocketResult {
  const mismatches: string[] = []
  const urls: string[] = []
  let cursor = 0
  const strict = opts.strictOut ?? true
  const factory: VoiceSocketFactory = (url): VoiceSocket => {
    urls.push(url)
    const cbs: { open: Array<() => void>; message: Array<(d: string) => void>; error: Array<(e: Error) => void>; close: Array<(c?: number) => void> } = { open: [], message: [], error: [], close: [] }
    let closed = false
    const pump = () => {
      while (!closed && cursor < exchange.frames.length && exchange.frames[cursor]!.dir === "in") {
        const f = exchange.frames[cursor++]!
        const data = typeof f.data === "string" ? f.data : JSON.stringify(f.data)
        for (const cb of cbs.message) cb(data)
      }
    }
    const sock: VoiceSocket = {
      send(data) {
        const text = typeof data === "string" ? data : Buffer.from(data).toString("base64")
        const next = exchange.frames[cursor]
        if (!next || next.dir !== "out") {
          if (strict) mismatches.push(`unexpected out frame: ${text.slice(0, 120)}`)
          return
        }
        cursor++
        let parsed: unknown = text
        try { parsed = JSON.parse(text) } catch { /* raw */ }
        if (strict && !sameJson(parsed, next.data)) {
          mismatches.push(`out frame differs: sent ${JSON.stringify(maskAudio(parsed)).slice(0, 160)} recorded ${JSON.stringify(maskAudio(next.data)).slice(0, 160)}`)
        }
        queueMicrotask(pump)
      },
      close(code) {
        if (closed) return
        closed = true
        queueMicrotask(() => cbs.close.forEach(cb => cb(code ?? 1000)))
      },
      on(event: string, cb: never) {
        ;(cbs as Record<string, unknown[]>)[event]!.push(cb)
      },
    }
    queueMicrotask(() => {
      cbs.open.forEach(cb => cb())
      pump()
    })
    return sock
  }
  return { factory, mismatches, urls, done: () => cursor >= exchange.frames.length }
}

/** A `fetch` that answers from recorded HTTP exchanges, matched by method and URL. */
export function makeReplayFetch(exchanges: readonly RecordedHttpExchange[]): {
  fetch: typeof fetch
  requests: Array<{ method: string; url: string; body: unknown }>
} {
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const f = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    let body: unknown = init?.body
    if (typeof body === "string") {
      try { body = JSON.parse(body) } catch { /* raw */ }
    }
    requests.push({ method, url, body })
    const hit = exchanges.find(e => e.request.method.toUpperCase() === method && e.request.url === url.replace(/[?&](xi-api-key|key)=[^&]*/g, ""))
    if (!hit) return new Response(JSON.stringify({ detail: "no recorded exchange" }), { status: 599 })
    const r = hit.response
    const payload = r.bodyBase64 !== undefined ? Buffer.from(r.bodyBase64, "base64") : JSON.stringify(r.body)
    return new Response(payload, { status: r.status, headers: { "content-type": r.contentType ?? "application/json" } })
  }) as unknown as typeof fetch
  return { fetch: f, requests }
}
