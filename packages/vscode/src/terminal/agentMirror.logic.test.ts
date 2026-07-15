import { describe, expect, it } from "vitest"

import { createLineEditorState, feedLineEditor } from "./agentMirror.logic.js"

describe("createLineEditorState", () => {
  it("starts with an empty buffer", () => {
    expect(createLineEditorState()).toEqual({ buffer: "" })
  })
})

describe("feedLineEditor", () => {
  it("echoes plain characters and accumulates the buffer", () => {
    const result = feedLineEditor(createLineEditorState(), "hi")
    expect(result.state).toEqual({ buffer: "hi" })
    expect(result.echo).toBe("hi")
    expect(result.submit).toBeUndefined()
  })

  it("appends across successive calls", () => {
    const first = feedLineEditor(createLineEditorState(), "he")
    const second = feedLineEditor(first.state, "llo")
    expect(second.state).toEqual({ buffer: "hello" })
    expect(second.echo).toBe("llo")
  })

  it("backspace (\\x7f) removes the last character and echoes \\b \\b", () => {
    const typed = feedLineEditor(createLineEditorState(), "hi")
    const result = feedLineEditor(typed.state, "\x7f")
    expect(result.state).toEqual({ buffer: "h" })
    expect(result.echo).toBe("\b \b")
  })

  it("backspace (\\b) also removes the last character", () => {
    const typed = feedLineEditor(createLineEditorState(), "hi")
    const result = feedLineEditor(typed.state, "\b")
    expect(result.state).toEqual({ buffer: "h" })
    expect(result.echo).toBe("\b \b")
  })

  it("backspace on an empty buffer is a no-op — no echo, no underflow", () => {
    const result = feedLineEditor(createLineEditorState(), "\x7f")
    expect(result.state).toEqual({ buffer: "" })
    expect(result.echo).toBe("")
  })

  it("multiple backspaces beyond the buffer length stop cleanly at empty", () => {
    const typed = feedLineEditor(createLineEditorState(), "ab")
    const result = feedLineEditor(typed.state, "\x7f\x7f\x7f")
    expect(result.state).toEqual({ buffer: "" })
    expect(result.echo).toBe("\b \b\b \b")
  })

  it("\\r submits the buffered line and resets it, echoing \\r\\n", () => {
    const typed = feedLineEditor(createLineEditorState(), "hello")
    const result = feedLineEditor(typed.state, "\r")
    expect(result.submit).toBe("hello")
    expect(result.state).toEqual({ buffer: "" })
    expect(result.echo).toBe("\r\n")
  })

  it("\\n also submits the buffered line", () => {
    const typed = feedLineEditor(createLineEditorState(), "hello")
    const result = feedLineEditor(typed.state, "\n")
    expect(result.submit).toBe("hello")
    expect(result.state).toEqual({ buffer: "" })
  })

  it("submitting an empty buffer yields submit: ''", () => {
    const result = feedLineEditor(createLineEditorState(), "\r")
    expect(result.submit).toBe("")
    expect(result.echo).toBe("\r\n")
  })

  it("handles a whole line pasted as one chunk, ending in Enter", () => {
    const result = feedLineEditor(createLineEditorState(), "hello world\r")
    expect(result.submit).toBe("hello world")
    expect(result.state).toEqual({ buffer: "" })
    expect(result.echo).toBe("hello world\r\n")
  })

  it("continues buffering after a mid-chunk Enter — only the LAST \\r in a chunk is reported as submit", () => {
    const result = feedLineEditor(createLineEditorState(), "ab\rcd\r")
    // "ab" was submitted and reset internally, but a single feedLineEditor
    // call reports at most one `submit` — the final one ("cd"). This is a
    // deliberate simplification (no readline here), not a full history.
    expect(result.submit).toBe("cd")
    expect(result.state).toEqual({ buffer: "" })
    expect(result.echo).toBe("ab\r\ncd\r\n")
  })

  it("drops control bytes (Tab, Escape) without adding them to the buffer or echo", () => {
    const result = feedLineEditor(createLineEditorState(), "a\tb\x1bc")
    expect(result.state).toEqual({ buffer: "abc" })
    expect(result.echo).toBe("abc")
  })

  it("treats a multi-byte code point (emoji) as one character for backspace", () => {
    const typed = feedLineEditor(createLineEditorState(), "hi\u{1F600}")
    expect(typed.state).toEqual({ buffer: "hi\u{1F600}" })
    const backspaced = feedLineEditor(typed.state, "\x7f")
    expect(backspaced.state).toEqual({ buffer: "hi" })
    expect(backspaced.echo).toBe("\b \b")
  })
})
