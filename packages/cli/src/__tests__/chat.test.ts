import { describe, it, expect } from "vitest"
import { classifyChatLine } from "../commands/chat.js"

describe("classifyChatLine", () => {
  it("treats the daemon turn-end marker as a suppressed boundary", () => {
    const r = classifyChatLine("\x1b[2m── turn-end (completed) ──\x1b[0m")
    expect(r.turnBoundary).toBe(true)
    expect(r.suppress).toBe(true)
    expect(r.plain).toBe("── turn-end (completed) ──")
  })

  it("matches turn-end regardless of reason", () => {
    expect(classifyChatLine("── turn-end (awaiting-input) ──").turnBoundary).toBe(true)
    expect(classifyChatLine("── turn-end (cancelled) ──").turnBoundary).toBe(true)
  })

  it("treats [awaiting input] as a shown boundary", () => {
    const r = classifyChatLine("\x1b[33m[awaiting input]\x1b[0m")
    expect(r.turnBoundary).toBe(true)
    expect(r.suppress).toBe(false)
  })

  it("passes ordinary text and tool lines through, no boundary", () => {
    const tool = classifyChatLine("\x1b[36m[tool] run_command\x1b[0m")
    expect(tool.turnBoundary).toBe(false)
    expect(tool.suppress).toBe(false)
    expect(tool.plain).toBe("[tool] run_command")

    const prose = classifyChatLine("There are 10 entries.")
    expect(prose.turnBoundary).toBe(false)
    expect(prose.suppress).toBe(false)
  })

  it("strips ANSI in the plain field", () => {
    expect(classifyChatLine("\x1b[1m\x1b[36myou\x1b[0m").plain).toBe("you")
  })
})
