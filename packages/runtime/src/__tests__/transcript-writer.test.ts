import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTranscriptWriter,
  sessionEventsPath,
  sessionTranscriptDir,
} from "../transcript-writer.js"

describe("createTranscriptWriter", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "transcript-writer-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function readLines(sessionId: string): Array<Record<string, unknown>> {
    const path = sessionEventsPath(sessionId, tmp)
    if (!existsSync(path)) return []
    const out: Array<Record<string, unknown>> = []
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as Record<string, unknown>)
      } catch {
        // Tolerate a deliberately-malformed line (torn-write regression test).
      }
    }
    return out
  }

  it("writes a user-prompt record for recordPrompt", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordPrompt("sess_1", "hello there")
    await writer.close("sess_1")

    const lines = readLines("sess_1")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: "user-prompt", text: "hello there", seq: 1 })
    expect(typeof lines[0]?.ts).toBe("string")
  })

  it("JSON-stringifies non-string prompt messages", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordPrompt("sess_1", { type: "text", text: "structured" })
    await writer.close("sess_1")

    const lines = readLines("sess_1")
    expect(lines[0]?.text).toBe(JSON.stringify({ type: "text", text: "structured" }))
  })

  it("coalesces consecutive text-delta chunks into one record per newline-terminated line", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordEvent("sess_1", { kind: "text-delta", text: "Hel" })
    writer.recordEvent("sess_1", { kind: "text-delta", text: "lo wor" })
    writer.recordEvent("sess_1", { kind: "text-delta", text: "ld\n" })
    writer.recordEvent("sess_1", { kind: "text-delta", text: "second line\n" })
    await writer.close("sess_1")

    const textLines = readLines("sess_1").filter(l => l.kind === "text-delta")
    expect(textLines).toHaveLength(2)
    expect(textLines[0]?.text).toBe("Hello world\n")
    expect(textLines[1]?.text).toBe("second line\n")
  })

  it("represents a blank (paragraph-break) line as a bare newline, not an empty string", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordEvent("sess_1", { kind: "text-delta", text: "para one\n\npara two\n" })
    await writer.close("sess_1")

    const textLines = readLines("sess_1").filter(l => l.kind === "text-delta")
    expect(textLines.map(l => l.text)).toEqual(["para one\n", "\n", "para two\n"])
  })

  it("reproduces multi-line markdown (incl. blank lines) byte-for-byte when the emitted deltas are concatenated", async () => {
    const original =
      "## Heading\n\n- item one\n- item two\n\nSome prose that keeps going" +
      " across multiple word-sized chunks.\n\nFinal line, no trailing newline"

    // Feed it through in small, arbitrarily-sized chunks — mirrors a
    // real CLI streaming word-by-word rather than one flush per line.
    const writer = createTranscriptWriter({ baseDir: tmp })
    const CHUNK = 7
    for (let i = 0; i < original.length; i += CHUNK) {
      writer.recordEvent("sess_1", { kind: "text-delta", text: original.slice(i, i + CHUNK) })
    }
    await writer.close("sess_1")

    const reconstructed = readLines("sess_1")
      .filter(l => l.kind === "text-delta")
      .map(l => l.text as string)
      .join("")
    expect(reconstructed).toBe(original)
  })

  it("coalesces thought chunks independently of text-delta", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordEvent("sess_1", { kind: "thought", text: "thinking a bit " })
    writer.recordEvent("sess_1", { kind: "thought", text: "more\n" })
    await writer.close("sess_1")

    const lines = readLines("sess_1")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: "thought", text: "thinking a bit more\n" })
  })

  it("flushes a partial (no-newline) text buffer before a tool-call so on-disk order matches emission order", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordEvent("sess_1", { kind: "text-delta", text: "no newline yet" })
    writer.recordEvent("sess_1", {
      kind: "tool-call",
      toolCallId: "t1",
      toolName: "bash",
      arguments: { command: "ls" },
    })
    await writer.close("sess_1")

    const lines = readLines("sess_1")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ kind: "text-delta", text: "no newline yet" })
    expect(lines[1]).toMatchObject({ kind: "tool-call", toolCallId: "t1", toolName: "bash" })
    expect(lines[1]?.arguments).toEqual({ command: "ls" })
  })

  it("records tool-call then tool-result with the matching toolCallId", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordEvent("sess_1", {
      kind: "tool-call",
      toolCallId: "t1",
      toolName: "bash",
      arguments: { command: "ls" },
    })
    writer.recordEvent("sess_1", {
      kind: "tool-result",
      toolCallId: "t1",
      result: "file1.txt",
      isError: false,
    })
    await writer.close("sess_1")

    // tool-call, tool-result, and the normalized tool-call-record the
    // tool-result handler derives from them (see "normalized ToolCallRecord"
    // describe block below).
    const lines = readLines("sess_1")
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatchObject({
      kind: "tool-result",
      toolCallId: "t1",
      result: "file1.txt",
      isError: false,
    })
  })

  it("flushes buffered text and writes a turn-end record at turn boundaries", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordEvent("sess_1", { kind: "text-delta", text: "trailing fragment" })
    writer.recordEvent("sess_1", { kind: "turn-end", reason: "completed" })
    await writer.close("sess_1")

    const lines = readLines("sess_1")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ kind: "text-delta", text: "trailing fragment" })
    expect(lines[1]).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("records plan and usage_update events verbatim", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordEvent("sess_1", {
      kind: "plan",
      entries: [
        { content: "step 1", priority: "high", status: "completed" },
        { content: "step 2", priority: "medium", status: "pending" },
      ],
    })
    writer.recordEvent("sess_1", {
      kind: "usage_update",
      size: 100_000,
      used: 4_200,
      cost: { amount: 0.12, currency: "USD" },
    })
    await writer.close("sess_1")

    const lines = readLines("sess_1")
    expect(lines[0]?.kind).toBe("plan")
    expect(lines[0]?.entries).toHaveLength(2)
    expect(lines[1]).toMatchObject({
      kind: "usage_update",
      size: 100_000,
      used: 4_200,
      cost: { amount: 0.12, currency: "USD" },
    })
  })

  it("assigns monotonically increasing seq numbers within a session", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordPrompt("sess_1", "one")
    writer.recordEvent("sess_1", { kind: "turn-end", reason: "completed" })
    await writer.close("sess_1")

    expect(readLines("sess_1").map(l => l.seq)).toEqual([1, 2])
  })

  it("keeps separate sessions in separate files", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordPrompt("sess_a", "for a")
    writer.recordPrompt("sess_b", "for b")
    await writer.close("sess_a")
    await writer.close("sess_b")

    expect(readLines("sess_a")).toHaveLength(1)
    expect(readLines("sess_b")).toHaveLength(1)
    expect(readLines("sess_a")[0]?.text).toBe("for a")
    expect(readLines("sess_b")[0]?.text).toBe("for b")
  })

  it("reopens and appends to an existing events.jsonl after a simulated daemon restart", async () => {
    const writerA = createTranscriptWriter({ baseDir: tmp })
    writerA.recordPrompt("sess_1", "before restart")
    await writerA.close("sess_1")

    // A fresh daemon process constructs a brand new writer instance —
    // in-memory seq/buffer state is gone, but the file itself survives.
    const writerB = createTranscriptWriter({ baseDir: tmp })
    writerB.recordPrompt("sess_1", "after restart")
    await writerB.close("sess_1")

    const lines = readLines("sess_1")
    expect(lines).toHaveLength(2)
    expect(lines[0]?.text).toBe("before restart")
    expect(lines[1]?.text).toBe("after restart")
  })

  it("continues seq monotonically across a simulated daemon restart", async () => {
    const writerA = createTranscriptWriter({ baseDir: tmp })
    writerA.recordPrompt("sess_1", "one")
    writerA.recordEvent("sess_1", { kind: "turn-end", reason: "completed" })
    await writerA.close("sess_1")
    expect(readLines("sess_1").map(l => l.seq)).toEqual([1, 2])

    // Fresh writer instance opening the existing file must NOT restart at 1
    // — a duplicate seq would make a `since` cursor drop the post-restart
    // tail (see GET /sessions/:id/events).
    const writerB = createTranscriptWriter({ baseDir: tmp })
    writerB.recordPrompt("sess_1", "two")
    writerB.recordEvent("sess_1", { kind: "turn-end", reason: "completed" })
    await writerB.close("sess_1")

    const seqs = readLines("sess_1").map(l => l.seq)
    expect(seqs).toEqual([1, 2, 3, 4])
    // Strictly increasing with no repeats, the invariant a `since` reader relies on.
    expect(seqs).toEqual([...seqs].sort((a, b) => (a as number) - (b as number)))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it("resumes seq from the max on disk, skipping an unparseable line", async () => {
    // A pre-existing file whose middle line is malformed (e.g. a torn write
    // from a prior crash). highestSeqOnDisk must scan every parseable line
    // and resume from the real max (2), not choke on the bad line.
    const dir = sessionTranscriptDir("sess_1", tmp)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      sessionEventsPath("sess_1", tmp),
      [
        JSON.stringify({ seq: 1, ts: "2026-01-01T00:00:00.000Z", kind: "user-prompt", text: "one" }),
        "not valid json {{{",
        JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:00.000Z", kind: "turn-end" }),
      ].join("\n") + "\n",
    )

    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordPrompt("sess_1", "two")
    await writer.close("sess_1")

    const seqs = readLines("sess_1")
      .filter(l => typeof l.seq === "number")
      .map(l => l.seq)
    // 1 and 2 pre-existed; the appended record must be 3, never a repeat.
    expect(seqs).toContain(3)
    expect(Math.max(...(seqs as number[]))).toBe(3)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it("close() is a safe no-op for a session that never wrote anything", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    await expect(writer.close("sess_never")).resolves.toBeUndefined()
  })

  it("closeAll() flushes and closes every open session", async () => {
    const writer = createTranscriptWriter({ baseDir: tmp })
    writer.recordEvent("sess_a", { kind: "text-delta", text: "partial a" })
    writer.recordEvent("sess_b", { kind: "thought", text: "partial b" })
    await writer.closeAll()

    expect(readLines("sess_a")[0]?.text).toBe("partial a")
    expect(readLines("sess_b")[0]?.text).toBe("partial b")
  })

  describe("tool-call enrichments coalesce", () => {
    /**
     * The real shape, captured off the wire from the claude-code bridge: it
     * announces the call with an empty input, then streams `rawInput` as the
     * model types it. Each frame is a superseding SNAPSHOT, not an increment.
     */
    const streamOneCall = (writer: ReturnType<typeof createTranscriptWriter>): void => {
      writer.recordEvent("s1", { kind: "tool-call", toolCallId: "t1", toolName: "Terminal", arguments: {} })
      for (const args of [
        { adapter: "claude-code" },
        { adapter: "claude-code", cwd: "/tmp" },
        { adapter: "claude-code", cwd: "/tmp", role: "executor" },
        { adapter: "claude-code", cwd: "/tmp", role: "executor", prompt: "go" },
      ]) {
        writer.recordEvent("s1", {
          kind: "tool-call",
          toolCallId: "t1",
          toolName: "wc -l f.txt",
          arguments: args,
          isUpdate: true,
        })
      }
    }

    it("writes ONE enrichment per call, carrying the final input", async () => {
      const writer = createTranscriptWriter({ baseDir: tmp })
      streamOneCall(writer)
      writer.recordEvent("s1", { kind: "tool-result", toolCallId: "t1", result: "ok" })
      await writer.close("s1")

      const calls = readLines("s1").filter(r => r.kind === "tool-call")
      // Announcement + one enrichment. Writing every frame put six records on
      // disk for one call, and only the last of them was true.
      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({ toolName: "Terminal", arguments: {} })
      expect(calls[1]).toMatchObject({
        isUpdate: true,
        toolName: "wc -l f.txt",
        arguments: { adapter: "claude-code", cwd: "/tmp", role: "executor", prompt: "go" },
      })
    })

    it("puts the input on disk BEFORE the result it belongs to", async () => {
      const writer = createTranscriptWriter({ baseDir: tmp })
      streamOneCall(writer)
      writer.recordEvent("s1", { kind: "tool-result", toolCallId: "t1", result: "ok" })
      await writer.close("s1")

      expect(readLines("s1").map(r => r.kind)).toEqual([
        "tool-call",
        "tool-call",
        "tool-result",
        "tool-call-record",
      ])
    })

    it("never loses a held input when the call ends without a result", async () => {
      // A failing tool reports `error` and never a tool-result; a crashed
      // stream gets only the synthesized turn-end. Both must still flush.
      const writer = createTranscriptWriter({ baseDir: tmp })
      streamOneCall(writer)
      writer.recordEvent("s1", { kind: "turn-end", reason: "completed" })
      await writer.close("s1")

      const calls = readLines("s1").filter(r => r.kind === "tool-call")
      expect(calls).toHaveLength(2)
      expect(calls[1]).toMatchObject({ arguments: { prompt: "go" } })
      expect(readLines("s1").at(-1)?.kind).toBe("turn-end")
    })

    it("keeps calls apart — one enrichment each, in order", async () => {
      const writer = createTranscriptWriter({ baseDir: tmp })
      writer.recordEvent("s1", { kind: "tool-call", toolCallId: "a", toolName: "A", arguments: {} })
      writer.recordEvent("s1", { kind: "tool-call", toolCallId: "a", toolName: "A", arguments: { x: 1 }, isUpdate: true })
      // A second call's announcement forces the first's input out, in order.
      writer.recordEvent("s1", { kind: "tool-call", toolCallId: "b", toolName: "B", arguments: {} })
      writer.recordEvent("s1", { kind: "tool-call", toolCallId: "b", toolName: "B", arguments: { y: 2 }, isUpdate: true })
      writer.recordEvent("s1", { kind: "turn-end", reason: "completed" })
      await writer.close("s1")

      const calls = readLines("s1").filter(r => r.kind === "tool-call")
      expect(calls.map(r => [r.toolCallId, r.isUpdate ?? false])).toEqual([
        ["a", false],
        ["a", true],
        ["b", false],
        ["b", true],
      ])
    })

    it("flushes a held input on close, not only on a lifecycle event", async () => {
      const writer = createTranscriptWriter({ baseDir: tmp })
      streamOneCall(writer)
      await writer.closeAll()

      const calls = readLines("s1").filter(r => r.kind === "tool-call")
      expect(calls).toHaveLength(2)
      expect(calls[1]).toMatchObject({ arguments: { prompt: "go" } })
    })
  })

  describe("normalized ToolCallRecord (tool-result -> tool-call-record)", () => {
    it("emits a tool-call-record carrying the tool name, command/args, and isError", async () => {
      const writer = createTranscriptWriter({ baseDir: tmp })
      writer.recordEvent("sess_1", {
        kind: "tool-call",
        toolCallId: "t1",
        toolName: "Bash",
        arguments: { command: "ls -la", args: ["-la"] },
      })
      writer.recordEvent("sess_1", {
        kind: "tool-result",
        toolCallId: "t1",
        result: "file1.txt",
        isError: false,
      })
      await writer.close("sess_1")

      const records = readLines("sess_1").filter(r => r.kind === "tool-call-record")
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        sessionId: "sess_1",
        tool: "Bash",
        command: "ls -la",
        args: ["-la"],
        isError: false,
      })
      expect(typeof records[0]?.durationMs).toBe("number")
      expect(typeof records[0]?.ts).toBe("string")
    })

    it("uses the LATEST enrichment's arguments/toolName, not the bare announcement", async () => {
      const writer = createTranscriptWriter({ baseDir: tmp })
      writer.recordEvent("sess_1", { kind: "tool-call", toolCallId: "t1", toolName: "Terminal", arguments: {} })
      writer.recordEvent("sess_1", {
        kind: "tool-call",
        toolCallId: "t1",
        toolName: "wc -l f.txt",
        arguments: { command: "wc -l f.txt" },
        isUpdate: true,
      })
      writer.recordEvent("sess_1", { kind: "tool-result", toolCallId: "t1", result: "3", isError: false })
      await writer.close("sess_1")

      const record = readLines("sess_1").find(r => r.kind === "tool-call-record")
      expect(record).toMatchObject({ tool: "wc -l f.txt", command: "wc -l f.txt" })
    })

    it("omits command/args for a non-shell-shaped tool (e.g. Edit) instead of guessing", async () => {
      const writer = createTranscriptWriter({ baseDir: tmp })
      writer.recordEvent("sess_1", {
        kind: "tool-call",
        toolCallId: "t1",
        toolName: "Edit",
        arguments: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
      })
      writer.recordEvent("sess_1", { kind: "tool-result", toolCallId: "t1", result: "ok", isError: false })
      await writer.close("sess_1")

      const record = readLines("sess_1").find(r => r.kind === "tool-call-record")
      expect(record).toMatchObject({ tool: "Edit" })
      expect(record?.command).toBeUndefined()
      expect(record?.args).toBeUndefined()
    })

    it("marks isError true and still emits a record for a failed call", async () => {
      const writer = createTranscriptWriter({ baseDir: tmp })
      writer.recordEvent("sess_1", {
        kind: "tool-call",
        toolCallId: "t1",
        toolName: "Bash",
        arguments: { command: "false" },
      })
      writer.recordEvent("sess_1", {
        kind: "tool-result",
        toolCallId: "t1",
        result: "exit 1",
        isError: true,
      })
      await writer.close("sess_1")

      const record = readLines("sess_1").find(r => r.kind === "tool-call-record")
      expect(record).toMatchObject({ tool: "Bash", command: "false", isError: true })
    })

    it("emits one record per call when two calls finish in the same session", async () => {
      const writer = createTranscriptWriter({ baseDir: tmp })
      writer.recordEvent("sess_1", { kind: "tool-call", toolCallId: "a", toolName: "Bash", arguments: { command: "one" } })
      writer.recordEvent("sess_1", { kind: "tool-result", toolCallId: "a", result: "1", isError: false })
      writer.recordEvent("sess_1", { kind: "tool-call", toolCallId: "b", toolName: "Bash", arguments: { command: "two" } })
      writer.recordEvent("sess_1", { kind: "tool-result", toolCallId: "b", result: "2", isError: false })
      await writer.close("sess_1")

      const records = readLines("sess_1").filter(r => r.kind === "tool-call-record")
      expect(records.map(r => r.command)).toEqual(["one", "two"])
    })
  })
})
