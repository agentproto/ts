import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionEventsPath } from "../transcript-writer.js"
import { readToolCallRecords, writeToolCallRecord } from "../tool-call-log.js"
import type { ToolCallRecord } from "../tool-call-record.js"

function fakeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    sessionId: "sess_abc123",
    tool: "command_execute",
    command: "pnpm",
    args: ["test"],
    exitCode: 0,
    isError: false,
    durationMs: 12,
    ts: "2026-07-05T10:00:00.000Z",
    ...overrides,
  }
}

describe("tool-call-log", () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "tool-call-log-test-"))
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  describe("writeToolCallRecord", () => {
    it("appends a kind-tagged JSONL line to the session's events.jsonl", async () => {
      await writeToolCallRecord(fakeRecord({ sessionId: "sess_abc123" }), baseDir)

      const raw = readFileSync(sessionEventsPath("sess_abc123", baseDir), "utf8").trim()
      const lines = raw.split("\n")
      expect(lines).toHaveLength(1)
      const line = JSON.parse(lines[0]!)
      expect(line).toMatchObject({
        kind: "tool-call-record",
        sessionId: "sess_abc123",
        tool: "command_execute",
        command: "pnpm",
        args: ["test"],
        exitCode: 0,
        isError: false,
        durationMs: 12,
      })
    })

    it("does not throw when the directory cannot be created", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const blocker = join(baseDir, "not-a-dir")
      writeFileSync(blocker, "x")
      await writeToolCallRecord(fakeRecord({ sessionId: "sess_blocked" }), join(blocker, "nested"))
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe("readToolCallRecords", () => {
    it("returns [] when the session has no events.jsonl", async () => {
      expect(await readToolCallRecords("sess_missing", baseDir)).toEqual([])
    })

    it("reads back the record written by writeToolCallRecord, without the on-disk kind tag", async () => {
      await writeToolCallRecord(fakeRecord({ sessionId: "sess_roundtrip" }), baseDir)
      const records = await readToolCallRecords("sess_roundtrip", baseDir)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ sessionId: "sess_roundtrip", tool: "command_execute", command: "pnpm" })
      expect((records[0] as unknown as Record<string, unknown>).kind).toBeUndefined()
    })

    it("filters out a non-tool-call-record line sharing the same file (e.g. a bare CommandLogEntry)", async () => {
      mkdirSync(join(baseDir, "sess_mixed"), { recursive: true })
      const commandLogLine = JSON.stringify({
        ts: "2026-07-05T10:00:00.000Z",
        command: "pnpm",
        args: ["test"],
        cwd: "/workspace",
        exitCode: 0,
        signal: null,
        durationMs: 12,
        stdout: "ok\n",
        stderr: "",
      })
      writeFileSync(sessionEventsPath("sess_mixed", baseDir), `${commandLogLine}\n`)
      await writeToolCallRecord(fakeRecord({ sessionId: "sess_mixed" }), baseDir)

      const records = await readToolCallRecords("sess_mixed", baseDir)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ sessionId: "sess_mixed", tool: "command_execute" })
    })

    it("skips a malformed line instead of throwing", async () => {
      mkdirSync(join(baseDir, "sess_bad"), { recursive: true })
      writeFileSync(sessionEventsPath("sess_bad", baseDir), "not json at all\n")
      expect(await readToolCallRecords("sess_bad", baseDir)).toEqual([])
    })
  })
})
