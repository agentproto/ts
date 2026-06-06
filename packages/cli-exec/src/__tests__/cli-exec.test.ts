import { describe, expect, it } from "vitest"
import { spawnWithStdin, parseClaudeJsonOutput } from "../index.js"

describe("parseClaudeJsonOutput", () => {
  it("returns the result field of a JSON envelope", () => {
    const out = JSON.stringify({ result: "hello there", is_error: false })
    expect(parseClaudeJsonOutput(out)).toBe("hello there")
  })

  it("returns null when there is no result field", () => {
    expect(parseClaudeJsonOutput(JSON.stringify({ foo: 1 }))).toBeNull()
  })

  it("returns null when result is not a string", () => {
    expect(parseClaudeJsonOutput(JSON.stringify({ result: 42 }))).toBeNull()
  })

  it("returns null for non-JSON output", () => {
    expect(parseClaudeJsonOutput("plain text, no json")).toBeNull()
  })
})

describe("spawnWithStdin", () => {
  it("feeds stdin and captures stdout", async () => {
    const out = await spawnWithStdin({ command: "cat", stdin: "round trip" })
    expect(out).toBe("round trip")
  })

  it("passes argv through (prompt still arrives on stdin)", async () => {
    // `sh -c 'cat'` echoes stdin; proves args are forwarded, prompt is piped.
    const out = await spawnWithStdin({
      command: "sh",
      args: ["-c", "cat"],
      stdin: "via argv shell",
    })
    expect(out).toBe("via argv shell")
  })

  it("rejects on a non-zero exit, surfacing stderr", async () => {
    await expect(
      spawnWithStdin({
        command: "sh",
        args: ["-c", "echo boom >&2; exit 7"],
        stdin: "",
      })
    ).rejects.toThrow(/code 7: boom/)
  })

  it("rejects when the command is not runnable", async () => {
    await expect(
      spawnWithStdin({ command: "definitely-not-a-real-binary-xyz", stdin: "" })
    ).rejects.toThrow(/not runnable/)
  })

  it("rejects on timeout and kills the child", async () => {
    await expect(
      spawnWithStdin({
        command: "sh",
        args: ["-c", "sleep 2"],
        stdin: "",
        timeoutMs: 80,
      })
    ).rejects.toThrow(/timed out after 80ms/)
  })

  it("rejects immediately when the signal is already aborted", async () => {
    await expect(
      spawnWithStdin({
        command: "cat",
        stdin: "",
        signal: AbortSignal.abort(),
      })
    ).rejects.toThrow(/aborted before start/)
  })

  it("rejects when aborted mid-flight", async () => {
    const ctrl = new AbortController()
    const p = spawnWithStdin({
      command: "sh",
      args: ["-c", "sleep 2"],
      stdin: "",
      signal: ctrl.signal,
    })
    setTimeout(() => ctrl.abort(), 30)
    await expect(p).rejects.toThrow(/aborted/)
  })
})
