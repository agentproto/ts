import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Transport-liveness surface: `AcpClient.isConnected()` + `onDisconnect()`.
 *
 * The failure this exists for: an ACP wrapper's PROCESS routinely outlives
 * its own JSON-RPC stream. When the stream ends, the SDK aborts the
 * connection's signal with `Error("ACP connection closed")` and every later
 * RPC rejects — but nothing in the stack used to observe that, so the host
 * kept reporting a live session (`sess_950d1251`, 2026-09-25: still
 * `running`/`alive: true` 40+ minutes after its connection died).
 *
 * Mocks the SDK the same way client-on-activity.test.ts does, except the
 * fake connection carries a REAL AbortController — the exact primitive the
 * production `Connection.close()` aborts, so "connection closed" here means
 * what it means at runtime rather than what a bespoke stub decides.
 */

const mockInitialize = vi.fn()
const mockNewSession = vi.fn()
const mockLoadSession = vi.fn()
const mockPrompt = vi.fn()
const mockCancel = vi.fn()

/** The live connection's abort controller, re-created per test so one
 *  test's "closed" state can't leak into the next. */
let controller: AbortController

vi.mock("@agentclientprotocol/sdk", () => ({
  ndJsonStream: () => ({}),
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    get signal() {
      return controller.signal
    },
    initialize: mockInitialize,
    newSession: mockNewSession,
    loadSession: mockLoadSession,
    setSessionConfigOption: vi.fn().mockResolvedValue({}),
    prompt: mockPrompt,
    cancel: mockCancel,
  })),
}))

import { createAcpClient } from "../client/index.js"

function fakeStreams() {
  return { output: new WritableStream(), input: new ReadableStream() }
}

/** What the SDK actually aborts with when the stream simply ends (see
 *  `Connection.close`): `error ?? new Error("ACP connection closed")`. */
function closeConnection(err = new Error("ACP connection closed")): void {
  controller.abort(err)
}

describe("createAcpClient — transport liveness", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    controller = new AbortController()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-disconnect" })
    mockLoadSession.mockResolvedValue({})
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" })
    mockCancel.mockResolvedValue({})
  })

  it("reports connected while the connection is open", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    expect(client.isConnected()).toBe(true)
  })

  it("flips to disconnected the moment the connection closes — with the process untouched", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp" })
    expect(client.isConnected()).toBe(true)

    closeConnection()

    // This is the whole point: nothing about the subprocess changed, only
    // its stream. A pid probe would still say "alive".
    expect(client.isConnected()).toBe(false)
  })

  it("notifies an onDisconnect subscriber once, carrying the close error", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const seen: Error[] = []
    client.onDisconnect(err => seen.push(err))
    expect(seen).toHaveLength(0)

    closeConnection()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toBe("ACP connection closed")
  })

  it("does not fire a subscriber twice for one close", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const listener = vi.fn()
    client.onDisconnect(listener)

    closeConnection()
    // A second abort on an already-aborted controller is a no-op in the
    // platform, mirroring `Connection.close`'s own `if (aborted) return`.
    controller.abort(new Error("again"))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("notifies a subscriber that arrives AFTER the connection already died", async () => {
    // The race that makes late subscription safe: the daemon only gets the
    // session handle once `startSession` resolves, which can be after a
    // wrapper died. An `addEventListener` on an already-aborted signal never
    // fires, so this must be reported synchronously instead.
    const client = await createAcpClient({ ...fakeStreams() })
    closeConnection()

    const listener = vi.fn()
    client.onDisconnect(listener)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it("supports several independent subscribers", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const a = vi.fn()
    const b = vi.fn()
    client.onDisconnect(a)
    client.onDisconnect(b)

    closeConnection()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("synthesizes an Error when the connection aborts with a non-Error reason", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const seen: Error[] = []
    client.onDisconnect(err => seen.push(err))

    controller.abort("stdout ended")

    expect(seen[0]).toBeInstanceOf(Error)
    expect(seen[0]?.message).toBe("ACP connection closed")
  })
})
