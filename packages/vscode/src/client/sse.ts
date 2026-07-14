/**
 * Minimal SSE reader built on streamed fetch (no EventSource dependency —
 * VS Code's extension host has no DOM EventSource). Used by SessionStore's
 * focusOutput(id) to tail /sessions/:id/stream one session at a time.
 *
 * - Parses `data:` lines as JSON; multi-line `data:` frames are concatenated.
 * - Ignores comment lines (anything starting with `:` — keep-alive pings).
 * - Auto-reconnects with exponential backoff on network error or stream
 *   close, preserving the caller's onEvent/onError hooks.
 *
 * Frozen source contract (WP0): the signature stays stable so focusOutput
 * and any future SSE consumer can rely on it.
 */

export interface SseSubscription {
  /** Stop the reader and abort the in-flight request. Safe to call once. */
  close(): void
}

export interface SseHandlers {
  onEvent: (data: unknown) => void
  onError?: (err: Error) => void
}

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

/**
 * Subscribe to an SSE endpoint. Resolves once the first connection attempt
 * completes (success or failure); subsequent reconnects happen silently in
 * the background. Returns a subscription whose `close()` tears everything
 * down.
 */
export function subscribeSse(
  url: string,
  headers: Record<string, string>,
  handlers: SseHandlers,
  fetchImpl: typeof fetch = fetch,
): SseSubscription {
  let closed = false
  let backoff = INITIAL_BACKOFF_MS
  let controller: AbortController | undefined

  async function loop(): Promise<void> {
    while (!closed) {
      controller = new AbortController()
      try {
        const res = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "text/event-stream", ...headers },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          throw new Error(`SSE ${url} responded HTTP ${res.status}`)
        }
        // Stream opened — reset backoff for the next failure.
        backoff = INITIAL_BACKOFF_MS
        await readStream(res.body, handlers)
        // Stream ended without close() — the server dropped it; reconnect.
        if (closed) return
      } catch (err) {
        if (closed) return
        const error = err instanceof Error ? err : new Error(String(err))
        if (error.name === "AbortError") return
        handlers.onError?.(error)
      }
      if (closed) return
      await sleep(backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }

  void loop()

  return {
    close(): void {
      closed = true
      controller?.abort()
    },
  }
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  handlers: SseHandlers,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let pendingData: string[] = []

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line. Process every complete
      // frame currently in the buffer.
      let sep: number
      while ((sep = indexOfFrameEnd(buffer)) !== -1) {
        const frame = buffer.slice(0, sep)
        // Skip the trailing \n\n (2 chars) — but tolerate \r\n\r\n too.
        const after = buffer.indexOf("\n", sep + 1)
        buffer = buffer.slice(after === -1 ? buffer.length : after + 1)
        handleFrame(frame, pendingData, handlers)
        pendingData = []
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Find the index of the blank-line separator ending a frame. */
function indexOfFrameEnd(buf: string): number {
  const lf = buf.indexOf("\n\n")
  const crlf = buf.indexOf("\r\n\r\n")
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

function handleFrame(
  frame: string,
  pendingData: string[],
  handlers: SseHandlers,
): void {
  let hasData = false
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line === "") continue
    if (line.startsWith(":")) {
      // Comment / keep-alive — ignore.
      continue
    }
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") {
      pendingData.push(value)
      hasData = true
    }
    // `event:` / `id:` / `retry:` fields are ignored — the daemon's streams
    // are plain `data:` frames.
  }
  if (!hasData) return
  const joined = pendingData.join("\n")
  if (!joined) return
  try {
    handlers.onEvent(JSON.parse(joined))
  } catch {
    // Non-JSON data frame — swallow rather than kill the stream.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
