import { describe, it, expect } from "vitest"
import { formatToolCall, formatToolResult } from "../tool-presenter.js"

describe("formatToolCall", () => {
  it("summarizes ScheduleWakeup with delay + reason", () => {
    expect(
      formatToolCall("ScheduleWakeup", { delaySeconds: 30, reason: "checking CI" })
    ).toBe("⏰ wake in 30s — checking CI")
  })

  it("summarizes ScheduleWakeup without a reason", () => {
    expect(formatToolCall("ScheduleWakeup", { delaySeconds: 30 })).toBe("⏰ wake in 30s")
  })

  it("summarizes Task/subagent dispatch by description", () => {
    expect(formatToolCall("Task", { description: "audit the auth flow" })).toBe(
      "↳ subagent: audit the auth flow"
    )
  })

  it("summarizes TodoWrite by todo count", () => {
    expect(
      formatToolCall("TodoWrite", { todos: [{ content: "a" }, { content: "b" }] })
    ).toBe("☑ todos (2)")
  })

  it("summarizes ExitPlanMode as a fixed one-liner", () => {
    expect(formatToolCall("ExitPlanMode", {})).toBe("📋 plan ready")
  })

  it("sniffs a file-path-shaped arg for read-like tools", () => {
    expect(formatToolCall("view", { path: "src/foo.ts" })).toBe("view src/foo.ts")
    expect(formatToolCall("Read", { file_path: "src/bar.ts" })).toBe("Read src/bar.ts")
  })

  it("sniffs a query/pattern arg for search-like tools", () => {
    expect(formatToolCall("find_files", { pattern: "*.tsx" })).toBe("find_files *.tsx")
    expect(formatToolCall("search_content", { query: "TODO" })).toBe("search_content TODO")
  })

  it("sniffs a command arg", () => {
    expect(formatToolCall("Bash", { command: "ls -la" })).toBe("Bash ls -la")
  })

  it("does not duplicate a salient arg already baked into a curated title", () => {
    // claude-agent-acp maps known tools to a curated title ("Read src/foo.ts")
    // alongside structured arguments (path: "src/foo.ts") — appending the
    // salient arg again would render "Read src/foo.ts src/foo.ts".
    expect(formatToolCall("Read src/foo.ts", { path: "src/foo.ts" })).toBe(
      "Read src/foo.ts"
    )
  })

  it("falls back to compact JSON when no salient key is present", () => {
    const result = formatToolCall("mystery_tool", { a: 1, b: 2 })
    expect(result).toBe('mystery_tool {"a":1,"b":2}')
  })

  it("truncates a very long fallback to ~120 chars", () => {
    const result = formatToolCall("mystery_tool", { blob: "x".repeat(500) })
    expect(result.length).toBeLessThanOrEqual(120)
    expect(result.endsWith("…")).toBe(true)
  })

  it("returns just the tool name when there are no args", () => {
    expect(formatToolCall("noop", {})).toBe("noop")
  })
})

describe("formatToolResult", () => {
  it("returns the first line of an error message", () => {
    const result = formatToolResult(
      "Bash",
      { error: "ENOENT: no such file or directory\nat foo.js:1:1" },
      true
    )
    expect(result).toBe("ENOENT: no such file or directory")
  })

  it("returns a short outcome for single-line success output", () => {
    expect(formatToolResult("Bash", "done", false)).toBe("done")
  })

  it("returns a line/byte count for multi-line success output", () => {
    const result = formatToolResult("Read", "line1\nline2\nline3", false)
    expect(result).toBe("3 lines, 17B")
  })

  it("returns null when there's nothing useful to show", () => {
    expect(formatToolResult("noop", null, false)).toBeNull()
    expect(formatToolResult("noop", "", false)).toBeNull()
  })

  it("extracts text from an MCP-shaped content array", () => {
    const result = formatToolResult(
      "search_content",
      { content: [{ type: "text", text: "3 matches found" }] },
      false
    )
    expect(result).toBe("3 matches found")
  })
})
