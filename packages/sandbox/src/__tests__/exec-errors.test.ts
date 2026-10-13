import { describe, it, expect } from "vitest"
import { scrubCommandFromMessage, shortenCommand } from "../exec-errors.js"

describe("exec error hygiene", () => {
  it("leaves a short command untouched", () => {
    expect(shortenCommand("ls -la")).toBe("ls -la")
    expect(scrubCommandFromMessage("failed: ls -la", "ls -la")).toBe("failed: ls -la")
  })

  it("truncates a long command with a …(N chars) marker", () => {
    const cmd = "x".repeat(9000)
    const out = shortenCommand(cmd)
    expect(out).toBe(`${"x".repeat(200)}…(9000 chars)`)
  })

  it("replaces every verbatim echo of a long command inside an error message", () => {
    const cmd = "echo " + "y".repeat(500)
    const msg = `[invalid_argument] error starting process '/bin/bash -l -c ${cmd}' (${cmd})`
    const out = scrubCommandFromMessage(msg, cmd)
    expect(out).not.toContain("y".repeat(300))
    expect(out.match(/…\(505 chars\)/g)).toHaveLength(2)
    expect(out).toContain("[invalid_argument] error starting process")
  })
})
