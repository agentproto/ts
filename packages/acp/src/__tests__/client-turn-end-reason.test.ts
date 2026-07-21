import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Same ACP-SDK mocking pattern as client-turn-idle-watchdog.test.ts. These
// tests pin the stopReason → turn-end `reason` mapping in the ACP client's
// prompt() resolution path (client/index.ts). Regression guard for the
// false-green bug where a claude-sdk 401 returned stopReason "refusal" and was
// silently mapped to "completed" — an un-authenticated reviewer reporting
// success without posting a review.
// ---------------------------------------------------------------------------

const mockInitialize = vi.fn()
const mockNewSession = vi.fn()
const mockLoadSession = vi.fn()
const mockSetSessionConfigOption = vi.fn()
const mockPrompt = vi.fn()
const mockCancel = vi.fn()

vi.mock("@agentclientprotocol/sdk", () => ({
  ndJsonStream: () => ({}),
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    newSession: mockNewSession,
    loadSession: mockLoadSession,
    setSessionConfigOption: mockSetSessionConfigOption,
    prompt: mockPrompt,
    cancel: mockCancel,
    on: vi.fn(),
    off: vi.fn(),
  })),
}))

import { createAcpClient } from "../client/index.js"

function fakeStreams() {
  return { output: new WritableStream(), input: new ReadableStream() }
}

async function turnEndReasonFor(stopReason: unknown): Promise<string | undefined> {
  mockPrompt.mockResolvedValueOnce(
    stopReason === undefined ? {} : { stopReason },
  )
  const client = await createAcpClient({ ...fakeStreams() })
  const session = await client.newSession({ cwd: "/tmp" })
  const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[
    Symbol.asyncIterator
  ]()
  const { value } = await iter.next()
  return (value as { kind: string; reason?: string }).reason
}

describe("createAcpClient — stopReason → turn-end reason mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-reason" })
    mockLoadSession.mockResolvedValue({})
    mockSetSessionConfigOption.mockResolvedValue({})
    mockCancel.mockResolvedValue({})
  })

  it("maps end_turn to completed", async () => {
    expect(await turnEndReasonFor("end_turn")).toBe("completed")
  })

  it("maps cancelled to cancelled", async () => {
    expect(await turnEndReasonFor("cancelled")).toBe("cancelled")
  })

  it("maps the max_tokens budget cap to max_turns (a completion, not an error)", async () => {
    expect(await turnEndReasonFor("max_tokens")).toBe("max_turns")
  })

  it("maps the max_turn_requests budget cap to max_turns (a completion, not an error)", async () => {
    expect(await turnEndReasonFor("max_turn_requests")).toBe("max_turns")
  })

  it("maps refusal (e.g. a 401 auth failure) to error, NOT completed", async () => {
    expect(await turnEndReasonFor("refusal")).toBe("error")
  })

  it("maps an unknown stopReason to error (no false green)", async () => {
    expect(await turnEndReasonFor("something_new")).toBe("error")
  })

  it("maps a missing stopReason to error rather than assuming success", async () => {
    expect(await turnEndReasonFor(undefined)).toBe("error")
  })
})
