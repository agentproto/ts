import WebSocket from "ws"

export interface CdpEnvelope {
  method: string
  params: unknown
  sessionId?: string
}

export type CdpEnvelopeListener = (event: CdpEnvelope) => void

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface CdpMessage {
  id?: number
  method?: string
  params?: unknown
  sessionId?: string
  result?: unknown
  error?: { code?: number; message?: string }
}

function parseMessage(raw: WebSocket.RawData): CdpMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw.toString())
    return typeof value === "object" && value !== null ? (value as CdpMessage) : undefined
  } catch {
    return undefined
  }
}

/** A minimal flat-session CDP client over one browser websocket. */
export class CdpConnection {
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<CdpEnvelopeListener>()
  private _closed = false

  private constructor(
    private readonly ws: WebSocket,
    private readonly commandTimeoutMs: number,
  ) {
    ws.on("message", (raw) => {
      const msg = parseMessage(raw)
      if (!msg) return
      if (msg.id !== undefined) {
        const waiting = this.pending.get(msg.id)
        if (!waiting) return
        this.pending.delete(msg.id)
        clearTimeout(waiting.timer)
        if (msg.error) waiting.reject(new Error(`CDP ${waiting.method} failed: ${msg.error.message ?? "unknown error"}`))
        else waiting.resolve(msg.result)
        return
      }
      if (msg.method) {
        const event: CdpEnvelope = { method: msg.method, params: msg.params, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }
        for (const listener of this.listeners) listener(event)
      }
    })
    ws.on("close", () => this.markClosed("connection closed"))
    ws.on("error", () => this.markClosed("connection error"))
  }

  static connect(url: string, opts: { timeoutMs?: number; commandTimeoutMs?: number } = {}): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: opts.timeoutMs ?? 10_000 })
      ws.once("open", () => resolve(new CdpConnection(ws, opts.commandTimeoutMs ?? 30_000)))
      ws.once("error", (err) => reject(new Error(`[chrome] cannot open the DevTools websocket: ${err.message}`)))
    })
  }

  get closed(): boolean {
    return this._closed
  }

  private markClosed(reason: string): void {
    this._closed = true
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(`CDP ${waiting.method} aborted: ${reason}`))
      this.pending.delete(id)
    }
  }

  send<T = unknown>(method: string, params?: unknown, sessionId?: string): Promise<T> {
    if (this._closed) return Promise.reject(new Error(`CDP ${method} failed: connection is closed`))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${Math.round(this.commandTimeoutMs / 1000)}s`))
      }, this.commandTimeoutMs)
      this.pending.set(id, { method, resolve: (v) => resolve(v as T), reject, timer })
      this.ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}), ...(sessionId ? { sessionId } : {}) }), (err) => {
        if (!err) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`CDP ${method} could not be sent: ${err.message}`))
      })
    })
  }

  onEvent(listener: CdpEnvelopeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  close(): void {
    this.markClosed("closed by client")
    this.listeners.clear()
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close()
  }
}
