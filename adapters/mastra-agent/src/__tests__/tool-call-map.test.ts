import { describe, expect, it } from "vitest"
import {
  chunkToSessionUpdate,
  toolCallTitle,
  toolKindFor,
  type MastraStreamChunk,
} from "../tool-call-map.js"

describe("toolKindFor", () => {
  it("maps the workspace toolset to ACP kinds", () => {
    expect(toolKindFor("read_file")).toBe("read")
    expect(toolKindFor("list_dir")).toBe("read")
    expect(toolKindFor("write_file")).toBe("edit")
    expect(toolKindFor("edit_file")).toBe("edit")
    expect(toolKindFor("run_command")).toBe("execute")
  })
  it("falls back to 'other' for unknown tools", () => {
    expect(toolKindFor("search_web")).toBe("other")
  })
})

describe("toolCallTitle", () => {
  it("appends a command hint", () => {
    expect(toolCallTitle("run_command", { command: "ls -la" })).toBe(
      "run_command: ls -la",
    )
  })
  it("appends a path hint", () => {
    expect(toolCallTitle("read_file", { path: "src/index.ts" })).toBe(
      "read_file: src/index.ts",
    )
  })
  it("returns the bare name when no hint is present", () => {
    expect(toolCallTitle("list_dir", {})).toBe("list_dir")
    expect(toolCallTitle("list_dir", undefined)).toBe("list_dir")
  })
})

describe("chunkToSessionUpdate", () => {
  it("maps text-delta to an agent_message_chunk", () => {
    expect(
      chunkToSessionUpdate({ type: "text-delta", payload: { text: "hi" } }),
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    })
  })

  it("drops an empty text-delta", () => {
    expect(
      chunkToSessionUpdate({ type: "text-delta", payload: { text: "" } }),
    ).toBeNull()
  })

  it("maps tool-call to a tool_call update with kind/title/status/rawInput", () => {
    expect(
      chunkToSessionUpdate({
        type: "tool-call",
        payload: {
          toolCallId: "tc1",
          toolName: "run_command",
          args: { command: "echo hi" },
        },
      }),
    ).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "run_command: echo hi",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "echo hi" },
    })
  })

  it("maps a successful tool-result to a completed tool_call_update", () => {
    expect(
      chunkToSessionUpdate({
        type: "tool-result",
        payload: { toolCallId: "tc1", result: { stdout: "hi" } },
      }),
    ).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "completed",
      rawOutput: { stdout: "hi" },
    })
  })

  it("maps an errored tool-result to a failed tool_call_update", () => {
    expect(
      chunkToSessionUpdate({
        type: "tool-result",
        payload: { toolCallId: "tc1", result: "boom", isError: true },
      }),
    ).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" })
  })

  it("maps a tool-error chunk to a failed tool_call_update carrying the error message", () => {
    expect(
      chunkToSessionUpdate({
        type: "tool-error",
        payload: {
          toolCallId: "tc1",
          toolName: "command_execute",
          error: new Error("tool 'command_execute' is declared in AGENT.md but not wired"),
        },
      }),
    ).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "failed",
      rawOutput: { error: "tool 'command_execute' is declared in AGENT.md but not wired" },
    })
  })

  it("stringifies a non-Error tool-error payload", () => {
    expect(
      chunkToSessionUpdate({
        type: "tool-error",
        payload: { toolCallId: "tc1", error: "plain string error" },
      }),
    ).toMatchObject({ rawOutput: { error: "plain string error" } })

    expect(
      chunkToSessionUpdate({
        type: "tool-error",
        payload: { toolCallId: "tc1", error: { code: "ENOENT" } },
      }),
    ).toMatchObject({ rawOutput: { error: '{"code":"ENOENT"}' } })
  })

  it("drops tool chunks missing a toolCallId", () => {
    expect(
      chunkToSessionUpdate({ type: "tool-call", payload: { toolName: "x" } }),
    ).toBeNull()
    expect(
      chunkToSessionUpdate({ type: "tool-result", payload: {} }),
    ).toBeNull()
    expect(
      chunkToSessionUpdate({ type: "tool-error", payload: {} }),
    ).toBeNull()
  })

  it("ignores chunk types with no ACP surface", () => {
    expect(chunkToSessionUpdate({ type: "step-finish" } as unknown as MastraStreamChunk)).toBeNull()
    expect(chunkToSessionUpdate({ type: "finish" } as unknown as MastraStreamChunk)).toBeNull()
    expect(chunkToSessionUpdate({ type: "reasoning-delta" } as unknown as MastraStreamChunk)).toBeNull()
  })
})
