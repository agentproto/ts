import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionEventsPath } from "../transcript-writer.js"
import { readCommandLogEntry, writeCommandLogEntry, type CommandLogEntry } from "../command-log.js"

function fakeEntry(overrides: Partial<CommandLogEntry> = {}): CommandLogEntry {
  return {
    ts: "2026-07-05T10:00:00.000Z",
    command: "pnpm",
    args: ["test"],
    cwd: "/workspace",
    exitCode: 0,
    signal: null,
    durationMs: 12,
    stdout: "ok\n",
    stderr: "",
    ...overrides,
  }
}

describe("command-log", () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "command-log-test-"))
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  describe("writeCommandLogEntry", () => {
    it("writes a single JSONL line to the session's events.jsonl", async () => {
      await writeCommandLogEntry("sess_abc123", fakeEntry({ stdout: "3 passed\n" }), baseDir)

      const raw = readFileSync(sessionEventsPath("sess_abc123", baseDir), "utf8").trim()
      const lines = raw.split("\n")
      expect(lines).toHaveLength(1)
      const entry = JSON.parse(lines[0]!)
      expect(entry).toMatchObject({
        command: "pnpm",
        args: ["test"],
        exitCode: 0,
        signal: null,
        durationMs: 12,
        stdout: "3 passed\n",
        stderr: "",
      })
      expect(entry.truncated).toBeUndefined()
    })

    it("carries the truncated flag only when set", async () => {
      await writeCommandLogEntry("sess_trunc", fakeEntry({ truncated: true }), baseDir)
      const entry = JSON.parse(readFileSync(sessionEventsPath("sess_trunc", baseDir), "utf8").trim())
      expect(entry.truncated).toBe(true)
    })

    it("does not throw when the directory cannot be created", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      // Point baseDir's parent at a path whose segment is a plain file —
      // mkdir(recursive) will fail underneath it.
      const blocker = join(baseDir, "not-a-dir")
      writeFileSync(blocker, "x")
      await writeCommandLogEntry("sess_blocked", fakeEntry(), join(blocker, "nested"))
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe("readCommandLogEntry", () => {
    it("returns null when the session has no recorded entry", async () => {
      expect(await readCommandLogEntry("sess_missing", baseDir)).toBeNull()
    })

    it("reads back the entry written by writeCommandLogEntry", async () => {
      await writeCommandLogEntry("sess_roundtrip", fakeEntry({ stdout: "hello\n" }), baseDir)
      const entry = await readCommandLogEntry("sess_roundtrip", baseDir)
      expect(entry).toMatchObject({ command: "pnpm", stdout: "hello\n", exitCode: 0 })
    })

    it("returns null for a malformed line instead of throwing", async () => {
      mkdirSync(join(baseDir, "sess_bad"), { recursive: true })
      writeFileSync(sessionEventsPath("sess_bad", baseDir), "not json at all\n")
      expect(await readCommandLogEntry("sess_bad", baseDir)).toBeNull()
    })
  })
})
