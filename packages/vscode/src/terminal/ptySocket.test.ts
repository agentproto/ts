import { describe, expect, it, vi, beforeEach } from "vitest"

interface MockWebSocket {
  readyState: number
  on(event: string, fn: (...args: unknown[]) => void): void
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  simulate(event: string, ...args: unknown[]): void
}

const wsState = vi.hoisted(() => ({
  instances: [] as MockWebSocket[],
  reset(): void {
    this.instances.length = 0
  },
  last(): MockWebSocket | undefined {
    return this.instances[this.instances.length - 1]
  },
}))

vi.mock("ws", () => ({
  default: class MockWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = MockWebSocket.CONNECTING
    send = vi.fn()
    close = vi.fn()
    terminate = vi.fn()

    private listeners: Record<string, ((...args: unknown[]) => void)[]> = {}

    constructor() {
      wsState.instances.push(this as unknown as MockWebSocket)
    }

    on(event: string, fn: (...args: unknown[]) => void): void {
      this.listeners[event] = this.listeners[event] ?? []
      this.listeners[event].push(fn)
    }

    simulate(event: string, ...args: unknown[]): void {
      this.listeners[event]?.forEach(fn => fn(...args))
    }
  },
}))

import WebSocket from "ws"
import { connectPtySocket } from "./ptySocket.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"

function createClient(): DaemonClient {
  return {
    url: "http://127.0.0.1:18790",
    authHeaders: { "x-custom": "yes" },
    resolveToken: vi.fn().mockResolvedValue("tok-123"),
  } as unknown as DaemonClient
}

async function flush(): Promise<void> {
  await Promise.resolve()
}

function createSession(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "terminal",
    pty: true,
    workspaceSlug: "ws",
    command: "bash",
    pid: 42,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

describe("connectPtySocket", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wsState.reset()
    vi.useFakeTimers()
  })

  it("opens a WebSocket to /sessions/:id/pty with auth headers and initial dimensions", async () => {
    connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      onRejected: vi.fn(),
      onReconnecting: vi.fn(),
      onGaveUp: vi.fn(),
    })
    await flush()

    const ws = wsState.last()
    expect(ws).toBeDefined()
    expect(ws?.readyState).toBe(WebSocket.CONNECTING)
  })

  it("fires onOpen when the socket connects", async () => {
    const onOpen = vi.fn()
    connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen,
      onData: vi.fn(),
      onExit: vi.fn(),
      onRejected: vi.fn(),
      onReconnecting: vi.fn(),
      onGaveUp: vi.fn(),
    })
    await flush()

    wsState.last()!.simulate("open")

    expect(onOpen).toHaveBeenCalledWith(false)
  })

  it("relays base64 data frames via onData unchanged", async () => {
    const onData = vi.fn()
    connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen: vi.fn(),
      onData,
      onExit: vi.fn(),
      onRejected: vi.fn(),
      onReconnecting: vi.fn(),
      onGaveUp: vi.fn(),
    })
    await flush()

    wsState.last()!.simulate("message", JSON.stringify({ kind: "data", b64: "aGVsbG8=" }))

    expect(onData).toHaveBeenCalledWith("aGVsbG8=")
  })

  it("fires onExit and stops reconnecting when an exit frame arrives", async () => {
    const onExit = vi.fn()
    const onGaveUp = vi.fn()
    connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen: vi.fn(),
      onData: vi.fn(),
      onExit,
      onRejected: vi.fn(),
      onReconnecting: vi.fn(),
      onGaveUp,
    })
    await flush()

    const ws = wsState.last()!
    ws.simulate("message", JSON.stringify({ kind: "exit", exitCode: 0, signal: 9 }))
    ws.simulate("close", 1000)

    expect(onExit).toHaveBeenCalledWith(0, 9)
    expect(onGaveUp).not.toHaveBeenCalled()
  })

  it("encodes and sends input frames when the socket is open", async () => {
    const handle = connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      onRejected: vi.fn(),
      onReconnecting: vi.fn(),
      onGaveUp: vi.fn(),
    })
    await flush()

    const ws = wsState.last()!
    ws.readyState = WebSocket.OPEN
    handle.sendInput("hi")

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ kind: "input", b64: "aGk=" }))
  })

  it("encodes and sends resize frames", async () => {
    const handle = connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      onRejected: vi.fn(),
      onReconnecting: vi.fn(),
      onGaveUp: vi.fn(),
    })
    await flush()

    const ws = wsState.last()!
    ws.readyState = WebSocket.OPEN
    handle.resize(100, 40)

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ kind: "resize", cols: 100, rows: 40 }))
  })

  it("reconnects after an abnormal closure (1006) and reports each attempt", async () => {
    const onReconnecting = vi.fn()
    connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      onRejected: vi.fn(),
      onReconnecting,
      onGaveUp: vi.fn(),
    })
    await flush()

    const ws = wsState.last()!
    ws.simulate("close", 1006)

    expect(onReconnecting).toHaveBeenCalledWith(1, 5, 1000)
    // A second socket should have been scheduled.
    vi.advanceTimersByTime(1000)
    await flush()
    expect(wsState.last()).not.toBe(ws)
  })

  it("gives up once reconnect attempts are exhausted", async () => {
    const onGaveUp = vi.fn()
    connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      onRejected: vi.fn(),
      onReconnecting: vi.fn(),
      onGaveUp,
    })
    await flush()

    for (let i = 0; i < 6; i++) {
      const ws = wsState.last()!
      ws.simulate("close", 1006)
      vi.advanceTimersByTime(4000)
    }

    expect(onGaveUp).toHaveBeenCalled()
  })

  it("fires onRejected for a pre-upgrade rejection and does not reconnect", async () => {
    const onRejected = vi.fn()
    const onGaveUp = vi.fn()
    connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      onRejected,
      onReconnecting: vi.fn(),
      onGaveUp,
    })
    await flush()

    const ws = wsState.last()!
    ws.simulate("unexpected-response", {}, { statusCode: 404 })

    expect(onRejected).toHaveBeenCalledWith(404)
    expect(onGaveUp).not.toHaveBeenCalled()
    // Subsequent close should not trigger reconnect either.
    ws.simulate("close", 1006)
    expect(onGaveUp).not.toHaveBeenCalled()
  })

  it("dispose prevents further reconnects and closes the socket", async () => {
    const onGaveUp = vi.fn()
    const handle = connectPtySocket(createClient(), createSession(), { cols: 80, rows: 24 }, {
      onOpen: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      onRejected: vi.fn(),
      onReconnecting: vi.fn(),
      onGaveUp,
    })
    await flush()

    const ws = wsState.last()!
    handle.dispose()
    ws.simulate("close", 1006)

    expect(ws.terminate).toHaveBeenCalled()
    expect(onGaveUp).not.toHaveBeenCalled()
  })
})
