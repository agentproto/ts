import type { AgentControllerEvent } from "@mastra/core/agent-controller"
import { describe, expect, it } from "vitest"
import { createEventMapper, toolCallTitle, toolKindFor } from "../tool-call-map.js"

/** A minimal assistant `MastraDBMessage` for `message_update` events. */
function assistantMessage(
  id: string,
  parts: unknown[],
): Extract<AgentControllerEvent, { type: "message_update" }>["message"] {
  return {
    id,
    role: "assistant",
    createdAt: new Date(0),
    content: { format: 2, parts },
  } as Extract<AgentControllerEvent, { type: "message_update" }>["message"]
}

function update(
  id: string,
  parts: unknown[],
): AgentControllerEvent {
  return { type: "message_update", message: assistantMessage(id, parts) }
}

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

describe("createEventMapper — message_update text deltas", () => {
  it("emits only the new text suffix as an agent_message_chunk", () => {
    const map = createEventMapper()
    expect(map(update("m1", [{ type: "text", text: "hel" }]))).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hel" },
    })
    expect(map(update("m1", [{ type: "text", text: "hello" }]))).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "lo" },
    })
  })

  it("drops an update carrying no new text", () => {
    const map = createEventMapper()
    expect(map(update("m1", [{ type: "text", text: "hi" }]))).not.toBeNull()
    // Same accumulated text re-emitted (e.g. on a tool event) → no delta.
    expect(map(update("m1", [{ type: "text", text: "hi" }]))).toBeNull()
    expect(map(update("m1", []))).toBeNull()
  })

  it("concatenates text across parts, ignoring non-text parts", () => {
    const map = createEventMapper()
    expect(map(update("m1", [{ type: "text", text: "before " }]))).not.toBeNull()
    const mixed = [
      { type: "text", text: "before " },
      {
        type: "tool-invocation",
        toolInvocation: { state: "result", toolCallId: "tc1", toolName: "list_dir", args: {} },
      },
      { type: "reasoning", reasoning: "hmm", details: [] },
      { type: "text", text: "after" },
    ]
    expect(map(update("m1", mixed))).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "after" },
    })
  })

  it("tracks each message id independently", () => {
    const map = createEventMapper()
    expect(map(update("m1", [{ type: "text", text: "one" }]))).not.toBeNull()
    expect(map(update("m2", [{ type: "text", text: "two" }]))).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "two" },
    })
  })

  it("ignores non-assistant messages", () => {
    const map = createEventMapper()
    const message = {
      ...assistantMessage("m1", [{ type: "text", text: "user text" }]),
      role: "user",
    }
    expect(
      map({ type: "message_update", message } as AgentControllerEvent),
    ).toBeNull()
  })
})

describe("createEventMapper — tool events", () => {
  it("maps tool_start to a tool_call with kind/title/status/rawInput", () => {
    const map = createEventMapper()
    expect(
      map({
        type: "tool_start",
        toolCallId: "tc1",
        toolName: "run_command",
        args: { command: "echo hi" },
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

  it("maps a successful tool_end to a completed tool_call_update", () => {
    const map = createEventMapper()
    expect(
      map({
        type: "tool_end",
        toolCallId: "tc1",
        result: { stdout: "hi" },
        isError: false,
      }),
    ).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "completed",
      rawOutput: { stdout: "hi" },
    })
  })

  it("maps a failed tool_end to a failed tool_call_update carrying the error message", () => {
    const map = createEventMapper()
    expect(
      map({
        type: "tool_end",
        toolCallId: "tc1",
        result: new Error("tool 'command_execute' is declared in AGENT.md but not wired"),
        isError: true,
      }),
    ).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "failed",
      rawOutput: { error: "tool 'command_execute' is declared in AGENT.md but not wired" },
    })
  })

  it("stringifies a non-Error failed tool_end result", () => {
    const map = createEventMapper()
    expect(
      map({ type: "tool_end", toolCallId: "tc1", result: "plain string error", isError: true }),
    ).toMatchObject({ rawOutput: { error: "plain string error" } })
    expect(
      map({ type: "tool_end", toolCallId: "tc1", result: { code: "ENOENT" }, isError: true }),
    ).toMatchObject({ rawOutput: { error: '{"code":"ENOENT"}' } })
  })

  it("drops tool events missing a toolCallId", () => {
    const map = createEventMapper()
    expect(
      map({ type: "tool_start", toolCallId: "", toolName: "x", args: {} }),
    ).toBeNull()
    expect(
      map({ type: "tool_end", toolCallId: "", result: null, isError: false }),
    ).toBeNull()
  })
})

describe("createEventMapper — events with no ACP surface", () => {
  it("returns null for lifecycle/progress events", () => {
    const map = createEventMapper()
    const ignored: AgentControllerEvent[] = [
      { type: "agent_start" },
      { type: "agent_end", reason: "complete" },
      { type: "message_start", message: assistantMessage("m1", []) },
      { type: "message_end", message: assistantMessage("m1", []) },
      { type: "tool_update", toolCallId: "tc1", partialResult: "..." },
      { type: "tool_input_delta", toolCallId: "tc1", argsTextDelta: "{" },
      { type: "usage_update", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      { type: "info", message: "hello" },
      { type: "error", error: new Error("boom") },
    ]
    for (const event of ignored) expect(map(event)).toBeNull()
  })
})
