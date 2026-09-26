/**
 * The durable side of `mcp_app_tool_call`: the transcript writer appends a
 * seq-numbered `kind: "mcp_app_tool_call"` record (no args, no result), and
 * the registry finds the tool name behind an origin tool-call id.
 */
import { describe, expect, it } from "vitest"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTranscriptWriter, sessionEventsPath } from "../transcript-writer.js"
import { createSessionsRegistry } from "../sessions.js"

async function readRecords(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, "utf8")
  return raw.trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>)
}

describe("mcp_app_tool_call record", () => {
  it("is written in order with the session's own events and tapped live", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "mcp-app-record-"))
    const writer = createTranscriptWriter({ baseDir })
    const live: Array<Record<string, unknown>> = []
    writer.subscribe("s1", r => live.push(r))
    writer.recordEvent("s1", { kind: "tool-call", toolCallId: "tc-1", toolName: "mcp__guilde__dashboard", arguments: {} })
    writer.recordMcpAppToolCall("s1", {
      server: "guilde",
      tool: "refresh",
      originToolCallId: "tc-1",
      isError: false,
      durationMs: 12,
    })
    await writer.close("s1")
    const records = await readRecords(sessionEventsPath("s1", baseDir))
    expect(records.map(r => r.kind)).toEqual(["tool-call", "mcp_app_tool_call"])
    const { seq, ts, ...rest } = records[1]!
    expect(seq).toBe(2)
    expect(typeof ts).toBe("string")
    expect(rest).toEqual({
      kind: "mcp_app_tool_call",
      sessionId: "s1",
      server: "guilde",
      tool: "refresh",
      originToolCallId: "tc-1",
      isError: false,
      durationMs: 12,
    })
    expect(live.map(r => r.kind)).toEqual(["tool-call", "mcp_app_tool_call"])
  })

  it("registry.findToolCallName reads the origin call's (latest non-empty) name", async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), "mcp-app-lookup-"))
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    registry.recordMcpAppToolCall("s1", {
      server: "guilde",
      tool: "refresh",
      originToolCallId: "tc-1",
      isError: false,
      durationMs: 1,
    })
    expect(await registry.findToolCallName("s1", "tc-1")).toBeUndefined()
    expect(await registry.findToolCallName("missing-session", "tc-1")).toBeUndefined()

    const writer = createTranscriptWriter({ baseDir: transcriptDir })
    writer.recordEvent("s2", { kind: "tool-call", toolCallId: "tc-9", toolName: "mcp__guilde__dashboard", arguments: {} })
    writer.recordEvent("s2", { kind: "tool-call", toolCallId: "tc-9", toolName: "", arguments: { a: 1 }, isUpdate: true })
    await writer.close("s2")
    expect(await registry.findToolCallName("s2", "tc-9")).toBe("mcp__guilde__dashboard")
  })
})
