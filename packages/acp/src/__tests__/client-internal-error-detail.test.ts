import { describe, expect, it, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock the ACP SDK so we can control the JSON-RPC error shape a server's
// thrown handler error becomes. The SDK's `RequestError.internalError` maps
// a thrown error to code -32603 with message "Internal error" and the real
// cause ONLY in `error.data.details` — never in the message. Before the
// enrichment fix a host that read `error.message` saw a bare "Internal
// error" (e.g. a claude-code-cloud spawn refused for a missing claude.ai
// credential or an unpushed checkout) with no trace of why.
// ---------------------------------------------------------------------------

const mockNewSession = vi.fn()
const mockLoadSession = vi.fn()
const mockInitialize = vi.fn()
const mockPrompt = vi.fn()
const mockSetSessionConfigOption = vi.fn()

vi.mock("@agentclientprotocol/sdk", () => ({
  ndJsonStream: () => ({}),
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    newSession: mockNewSession,
    loadSession: mockLoadSession,
    prompt: mockPrompt,
    setSessionConfigOption: mockSetSessionConfigOption,
    on: vi.fn(),
    off: vi.fn(),
  })),
}))

import { createAcpClient } from "../client/index.js"

/** A JSON-RPC -32603 exactly as the SDK builds it from a thrown error. */
function internalError(details: string): Error {
  return Object.assign(new Error("Internal error"), {
    name: "RequestError",
    code: -32603,
    data: { details },
  })
}

function fakeStreams() {
  const output = new WritableStream()
  const readable = new ReadableStream()
  return { output, input: readable }
}

describe("createAcpClient — opaque -32603 'Internal error' carries its details", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockSetSessionConfigOption.mockResolvedValue({})
  })

  it("newSession surfaces the server-side cause from data.details", async () => {
    mockNewSession.mockRejectedValue(
      internalError(
        "claude code cloud: not logged in — cloud sessions need a claude.ai sign-in; run `claude auth login`",
      ),
    )
    const client = await createAcpClient({ ...fakeStreams() })
    await expect(client.newSession({ cwd: "/tmp/x" })).rejects.toThrow(
      /Internal error: claude code cloud: not logged in — cloud sessions need a claude\.ai sign-in/,
    )
  })

  it("newSession keeps the -32603 code on the enriched error", async () => {
    mockNewSession.mockRejectedValue(
      internalError(
        "claude code cloud: not a git repository (AIP-66 §3) — run `git init`",
      ),
    )
    const client = await createAcpClient({ ...fakeStreams() })
    try {
      await client.newSession({ cwd: "/tmp/x" })
      expect.unreachable("newSession must reject")
    } catch (err) {
      expect((err as { code?: number }).code).toBe(-32603)
      expect((err as Error).message).toContain("not a git repository")
    }
  })

  it("loadSession surfaces the server-side cause from data.details", async () => {
    mockLoadSession.mockRejectedValue(
      internalError(
        `claude code cloud: session/load needs the vendor session id, got "sess_123" — expected session_<id> or cse_<id> (AIP-66 §5)`,
      ),
    )
    const client = await createAcpClient({ ...fakeStreams() })
    await expect(
      client.loadSession({ sessionId: "sess_123", cwd: "/tmp/x" }),
    ).rejects.toThrow(
      /Internal error: claude code cloud: session\/load needs the vendor session id/,
    )
  })

  it("prompt turn errors surface the cause instead of a bare 'Internal error'", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "sess-detail" })
    mockPrompt.mockRejectedValue(
      internalError("Claude Code sessions API returned HTTP 429: rate limited"),
    )
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[
      Symbol.asyncIterator
    ]()
    const { value } = await iter.next()
    expect((value as { kind: string }).kind).toBe("error")
    expect(
      (value as { error: { message: string } }).error.message,
    ).toContain("Claude Code sessions API returned HTTP 429: rate limited")
  })

  it("non-opaque errors pass through untouched", async () => {
    mockNewSession.mockRejectedValue(new Error("plane error"))
    const client = await createAcpClient({ ...fakeStreams() })
    await expect(client.newSession({ cwd: "/tmp/x" })).rejects.toThrow(
      /^plane error$/,
    )
  })

  it("a -32603 with no readable details falls back to the raw message", async () => {
    mockNewSession.mockRejectedValue(
      Object.assign(new Error("Internal error"), { code: -32603, data: {} }),
    )
    const client = await createAcpClient({ ...fakeStreams() })
    await expect(client.newSession({ cwd: "/tmp/x" })).rejects.toThrow(
      /^Internal error$/,
    )
  })
})
