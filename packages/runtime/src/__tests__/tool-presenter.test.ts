import { describe, it, expect } from "vitest"
import {
  ARTIFACT_MARKER,
  artifactMarkerLines,
  formatToolCall,
  formatToolResult,
} from "../tool-presenter.js"

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

  it("extracts text from an opencode-shaped { output, metadata } result", () => {
    expect(formatToolResult("bash", { output: "wt/feature\n", metadata: { exit: 0 } }, false)).toBe(
      "wt/feature",
    )
    expect(
      formatToolResult("bash", { output: "line 1\nline 2\nline 3", metadata: {} }, false),
    ).toBe("3 lines, 20B")
  })

  // command_execute returns its whole result as ONE JSON string whose
  // newlines are escaped, so it has no literal `\n`. The generic path used to
  // truncate that JSON preamble to ~160 chars — the "I only see the cwd" bug.
  it("summarizes a command_execute JSON result from its real stdout, not the JSON preamble", () => {
    const json = JSON.stringify({ exitCode: 0, signal: null, stdout: "/Users/x/repo\n", stderr: "" })
    expect(formatToolResult("command_execute", json, false)).toBe("exit 0 · /Users/x/repo")
    expect(
      formatToolResult("command_execute", { content: [{ type: "text", text: json }] }, false),
    ).toBe("exit 0 · /Users/x/repo")
  })

  it("counts the real lines of a multi-line command_execute stdout", () => {
    const json = JSON.stringify({ exitCode: 0, signal: null, stdout: "a\nb\nc", stderr: "" })
    expect(formatToolResult("command_execute", json, false)).toBe("exit 0 · 3 lines, 5B")
  })

  it("prefers stderr and carries a non-zero exit code for a failed command", () => {
    const json = JSON.stringify({ exitCode: 1, signal: null, stdout: "", stderr: "boom: bad\nmore" })
    expect(formatToolResult("command_execute", json, false)).toBe("exit 1 · 2 lines, 14B")
    expect(formatToolResult("command_execute", json, true)).toBe("exit 1 · 2 lines, 14B")
  })

  it("leaves a non-command JSON (no stdout/stderr) on the plain-text path", () => {
    expect(formatToolResult("mystery", '{"a":1}', false)).toBe('{"a":1}')
  })

  it("reads a snake_case exit_code and reports an empty command as no output", () => {
    expect(
      formatToolResult("command_execute", JSON.stringify({ exit_code: 2, stdout: "", stderr: "" }), false),
    ).toBe("exit 2 · no output")
  })
})

describe("artifactMarkerLines", () => {
  const record = '{"kind":"review","id":5000347376,"url":"https://x","sha":"abc"}'

  it("extracts a marker line buried in multi-line tool stdout", () => {
    const stdout = `posting review…\n${ARTIFACT_MARKER}${record}\ncreated review id=5000347376`
    expect(artifactMarkerLines(stdout)).toEqual([`${ARTIFACT_MARKER}${record}`])
  })

  it("extracts markers from an MCP-shaped content array", () => {
    const result = {
      content: [{ type: "text", text: `${ARTIFACT_MARKER}${record}` }],
    }
    expect(artifactMarkerLines(result)).toEqual([`${ARTIFACT_MARKER}${record}`])
  })

  it("extracts markers from an opencode-shaped { output, metadata } result", () => {
    const result = {
      output: `posting review…\n${ARTIFACT_MARKER}${record}\ncreated review id=5000347376`,
      metadata: { exit: 0 },
    }
    expect(artifactMarkerLines(result)).toEqual([`${ARTIFACT_MARKER}${record}`])
  })

  it("keeps the marker parseable: tail of the line JSON-parses to the record", () => {
    const [line] = artifactMarkerLines(`${ARTIFACT_MARKER}${record}`)
    const idx = line!.indexOf(ARTIFACT_MARKER)
    const parsed = JSON.parse(line!.slice(idx + ARTIFACT_MARKER.length).trim()) as {
      kind: string
      id: number
    }
    expect(parsed.kind).toBe("review")
    expect(parsed.id).toBe(5000347376)
  })

  it("returns [] for results without a marker (the overwhelmingly common case)", () => {
    expect(artifactMarkerLines("regular output\nlines")).toEqual([])
    expect(artifactMarkerLines(null)).toEqual([])
    expect(artifactMarkerLines({ content: [] })).toEqual([])
  })

  it("caps pathological marker floods", () => {
    const flood = Array.from({ length: 50 }, () => `${ARTIFACT_MARKER}${record}`).join("\n")
    expect(artifactMarkerLines(flood).length).toBeLessThanOrEqual(8)
  })
})
