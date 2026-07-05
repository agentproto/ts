import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecuteResult } from "../command-tools.js"
import {
  appendCommandLogEntry,
  commandLogPath,
  findRecentCommandLogRef,
  tailCommandLog,
} from "../command-log.js"

function fakeResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "ok\n",
    stderr: "",
    durationMs: 12,
    ...overrides,
  }
}

describe("command-log", () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "command-log-test-"))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it("appends a JSONL entry mirroring the ExecuteResult fields", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-05T10:00:00Z"))

    await appendCommandLogEntry(
      workspace,
      { command: "pnpm", args: ["test"], cwd: workspace },
      fakeResult({ stdout: "3 passed\n" }),
    )

    const path = commandLogPath(workspace, "2026-07-05")
    const lines = readFileSync(path, "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0]!)
    expect(entry).toMatchObject({
      command: "pnpm",
      args: ["test"],
      cwd: workspace,
      exitCode: 0,
      signal: null,
      durationMs: 12,
      stdout: "3 passed\n",
      stderr: "",
    })
    expect(typeof entry.ts).toBe("string")
    expect(entry.truncated).toBeUndefined()
  })

  it("buckets entries by calendar day and appends multiple entries to the same day-file", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-05T08:00:00Z"))
    await appendCommandLogEntry(workspace, { command: "gh", args: [], cwd: workspace }, fakeResult())
    await appendCommandLogEntry(workspace, { command: "gh", args: ["pr"], cwd: workspace }, fakeResult())

    vi.setSystemTime(new Date("2026-07-06T08:00:00Z"))
    await appendCommandLogEntry(workspace, { command: "gh", args: ["issue"], cwd: workspace }, fakeResult())

    const day1 = readFileSync(commandLogPath(workspace, "2026-07-05"), "utf8").trim().split("\n")
    const day2 = readFileSync(commandLogPath(workspace, "2026-07-06"), "utf8").trim().split("\n")
    expect(day1).toHaveLength(2)
    expect(day2).toHaveLength(1)
  })

  it("carries the truncated flag only when set", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-05T08:00:00Z"))
    await appendCommandLogEntry(
      workspace,
      { command: "node", args: [], cwd: workspace },
      fakeResult({ truncated: true }),
    )
    const entry = JSON.parse(
      readFileSync(commandLogPath(workspace, "2026-07-05"), "utf8").trim(),
    )
    expect(entry.truncated).toBe(true)
  })

  it("does not throw when the workspace directory cannot be written to", async () => {
    // Point at a workspace path that doesn't exist and whose parent is a
    // file, not a directory — mkdir(recursive) will fail. The append must
    // swallow the error (console.warn) rather than reject / throw.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const blocker = join(workspace, "not-a-dir")
    writeFileSync(blocker, "x")
    await expect(
      appendCommandLogEntry(
        blocker,
        { command: "ls", args: [], cwd: blocker },
        fakeResult(),
      ),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  describe("tailCommandLog", () => {
    it("returns an empty array when no log directory exists", async () => {
      expect(await tailCommandLog(workspace)).toEqual([])
    })

    it("reads back entries newest-last, respecting lastN", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-05T08:00:00Z"))
      for (let i = 0; i < 5; i++) {
        await appendCommandLogEntry(
          workspace,
          { command: "echo", args: [String(i)], cwd: workspace },
          fakeResult({ stdout: String(i) }),
        )
      }

      const all = await tailCommandLog(workspace)
      expect(all).toHaveLength(5)
      expect(all.map(e => e.stdout)).toEqual(["0", "1", "2", "3", "4"])

      const lastTwo = await tailCommandLog(workspace, { lastN: 2 })
      expect(lastTwo.map(e => e.stdout)).toEqual(["3", "4"])
    })

    it("spans multiple day-files, newest day first, until lastN is filled", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-04T08:00:00Z"))
      await appendCommandLogEntry(
        workspace,
        { command: "echo", args: ["day1"], cwd: workspace },
        fakeResult({ stdout: "day1" }),
      )
      vi.setSystemTime(new Date("2026-07-05T08:00:00Z"))
      await appendCommandLogEntry(
        workspace,
        { command: "echo", args: ["day2"], cwd: workspace },
        fakeResult({ stdout: "day2" }),
      )

      const tail = await tailCommandLog(workspace, { lastN: 10 })
      expect(tail.map(e => e.stdout)).toEqual(["day1", "day2"])
    })

    it("respects the since cursor to skip earlier day-files", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-01T08:00:00Z"))
      await appendCommandLogEntry(
        workspace,
        { command: "echo", args: ["old"], cwd: workspace },
        fakeResult({ stdout: "old" }),
      )
      vi.setSystemTime(new Date("2026-07-05T08:00:00Z"))
      await appendCommandLogEntry(
        workspace,
        { command: "echo", args: ["new"], cwd: workspace },
        fakeResult({ stdout: "new" }),
      )

      const tail = await tailCommandLog(workspace, { since: "2026-07-05" })
      expect(tail.map(e => e.stdout)).toEqual(["new"])
    })

    it("skips malformed lines instead of failing the whole tail", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-05T08:00:00Z"))
      await appendCommandLogEntry(
        workspace,
        { command: "echo", args: ["good"], cwd: workspace },
        fakeResult({ stdout: "good" }),
      )
      const path = commandLogPath(workspace, "2026-07-05")
      writeFileSync(path, `${readFileSync(path, "utf8")}not json at all\n`)

      const tail = await tailCommandLog(workspace)
      expect(tail.map(e => e.stdout)).toEqual(["good"])
    })
  })

  describe("findRecentCommandLogRef", () => {
    it("returns undefined when the workspace has no command log", () => {
      expect(findRecentCommandLogRef(workspace)).toBeUndefined()
    })

    it("returns undefined when today's log file exists but is empty", () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-05T08:00:00Z"))
      const dir = join(workspace, ".agentproto", "command-log")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "2026-07-05.jsonl"), "")
      expect(findRecentCommandLogRef(workspace)).toBeUndefined()
    })

    it("returns a workspace-relative pointer to today's nonempty log", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-05T08:00:00Z"))
      await appendCommandLogEntry(
        workspace,
        { command: "echo", args: [], cwd: workspace },
        fakeResult(),
      )
      expect(findRecentCommandLogRef(workspace)).toBe(
        ".agentproto/command-log/2026-07-05.jsonl",
      )
    })

    it("falls back to a recent prior day within the lookback window", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-03T08:00:00Z"))
      await appendCommandLogEntry(
        workspace,
        { command: "echo", args: [], cwd: workspace },
        fakeResult(),
      )
      vi.setSystemTime(new Date("2026-07-05T08:00:00Z"))
      expect(findRecentCommandLogRef(workspace)).toBe(
        ".agentproto/command-log/2026-07-03.jsonl",
      )
    })
  })
})
