/**
 * Regression tests for HarnessClient#call.
 *
 * Covers:
 *   - isError:true → throws instead of crashing on JSON.parse
 *   - empty content → throws "No content" error
 *   - happy path → parses JSON and returns typed result
 *
 * Uses vi.mock to stub both MCP SDK modules so no network is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── SDK mocks (hoisted) ──────────────────────────────────────────────────────

const mockCallTool = vi.fn()
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockClose = vi.fn().mockResolvedValue(undefined)

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
    close: mockClose,
  })),
}))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}))

// ── Subject under test ───────────────────────────────────────────────────────

import { HarnessClient } from "../client.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

async function freshClient(): Promise<HarnessClient> {
  return HarnessClient.connect({ url: "http://localhost:18790/mcp" })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("HarnessClient#call — isError guard (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
  })

  it("throws a descriptive error when isError:true, not a JSON.parse crash", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "session not found" }],
      isError: true,
    })
    const hc = await freshClient()
    await expect(hc.output("sess_missing")).rejects.toThrow(
      "Tool `get_agent_session_output` returned error: session not found",
    )
  })

  it("throws 'No content' when content array is empty", async () => {
    mockCallTool.mockResolvedValue({
      content: [],
      isError: false,
    })
    const hc = await freshClient()
    await expect(hc.output("sess_missing")).rejects.toThrow(
      "No content from tool `get_agent_session_output`",
    )
  })

  it("throws 'No content' when text field is undefined", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "text" }],
      isError: false,
    })
    const hc = await freshClient()
    await expect(hc.output("sess_missing")).rejects.toThrow(
      "No content from tool `get_agent_session_output`",
    )
  })

  it("parses and returns JSON when isError is absent/false", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ lines: ["hello", "world"] }) }],
    })
    const hc = await freshClient()
    const out = await hc.output("sess_ok")
    expect(out).toBe("hello\nworld")
  })

  it("does not attempt JSON.parse on an error text (isError:true with non-JSON text)", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "Internal daemon error: OOM" }],
      isError: true,
    })
    const hc = await freshClient()
    // If JSON.parse ran on "Internal daemon error: OOM" it would throw a
    // SyntaxError. We assert we get the structured error message instead.
    await expect(hc.output("sess_oom")).rejects.toThrow(
      "Tool `get_agent_session_output` returned error: Internal daemon error: OOM",
    )
  })
})
