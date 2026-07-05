import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTerminalTranscriptWriter, terminalLogPath } from "../terminal-transcript-writer.js"

describe("createTerminalTranscriptWriter", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "terminal-transcript-writer-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function readLines(sessionId: string): Array<{ ts: string; bytes: string }> {
    const path = terminalLogPath(sessionId, tmp)
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l))
  }

  it("appends one base64-encoded record per chunk", async () => {
    const writer = createTerminalTranscriptWriter({ baseDir: tmp })
    writer.appendChunk("sess_1", Buffer.from("hello pty\n", "utf8"))
    writer.appendChunk("sess_1", Buffer.from("more output\n", "utf8"))
    await writer.close("sess_1")

    const lines = readLines("sess_1")
    expect(lines).toHaveLength(2)
    expect(Buffer.from(lines[0]!.bytes, "base64").toString("utf8")).toBe("hello pty\n")
    expect(Buffer.from(lines[1]!.bytes, "base64").toString("utf8")).toBe("more output\n")
    expect(typeof lines[0]!.ts).toBe("string")
  })

  it("round-trips arbitrary non-UTF8 bytes without corruption", async () => {
    const writer = createTerminalTranscriptWriter({ baseDir: tmp })
    const raw = Buffer.from([0x1b, 0x5b, 0x32, 0x4a, 0xff, 0xfe, 0x00, 0x41])
    writer.appendChunk("sess_1", raw)
    await writer.close("sess_1")

    const lines = readLines("sess_1")
    expect(Buffer.from(lines[0]!.bytes, "base64").equals(raw)).toBe(true)
  })

  it("keeps separate sessions in separate files", async () => {
    const writer = createTerminalTranscriptWriter({ baseDir: tmp })
    writer.appendChunk("sess_a", Buffer.from("a"))
    writer.appendChunk("sess_b", Buffer.from("b"))
    await writer.closeAll()

    expect(readLines("sess_a")).toHaveLength(1)
    expect(readLines("sess_b")).toHaveLength(1)
  })

  it("close is safe to call twice and for a session that never wrote", async () => {
    const writer = createTerminalTranscriptWriter({ baseDir: tmp })
    await writer.close("sess_never_wrote")
    writer.appendChunk("sess_1", Buffer.from("x"))
    await writer.close("sess_1")
    await expect(writer.close("sess_1")).resolves.toBeUndefined()
  })

  it("closeAll flushes and closes every open stream", async () => {
    const writer = createTerminalTranscriptWriter({ baseDir: tmp })
    writer.appendChunk("sess_1", Buffer.from("one"))
    writer.appendChunk("sess_2", Buffer.from("two"))
    await writer.closeAll()

    expect(readLines("sess_1")).toHaveLength(1)
    expect(readLines("sess_2")).toHaveLength(1)
    await expect(writer.closeAll()).resolves.toBeUndefined()
  })
})
