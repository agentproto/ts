import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import {
  RESUME_STRATEGIES,
  hasResumeStrategy,
} from "../resume-strategies.js"

/**
 * The resume-strategy table is consumed by two surfaces (daemon
 * output sniffer + CLI restart logic). These tests pin its shape so
 * a future refactor doesn't silently lose claude-code's hooks — the
 * symptom would be no resume working but the build still passing.
 */

describe("RESUME_STRATEGIES", () => {
  it("includes claude-code with all three hooks", () => {
    const s = RESUME_STRATEGIES["claude-code"]
    expect(s).toBeDefined()
    expect(s?.outputHint).toBeInstanceOf(RegExp)
    expect(s?.fsProbe).toBeTypeOf("function")
    expect(s?.spawnArgs).toBeTypeOf("function")
    expect(s?.storeAs).toBe("claudeResumeId")
  })

  it("claude-code spawnArgs returns the expected argv", () => {
    const s = RESUME_STRATEGIES["claude-code"]!
    const id = "0e483f81-1a44-4bec-9667-b37158450296"
    expect(s.spawnArgs?.(id)).toEqual(["claude", "--resume", id])
  })

  it("claude-code outputHint captures the resume id from a typical exit line", () => {
    const s = RESUME_STRATEGIES["claude-code"]!
    const line =
      "Resume this session with: claude --resume 0e483f81-1a44-4bec-9667-b37158450296"
    const m = line.match(s.outputHint!)
    expect(m?.[1]).toBe("0e483f81-1a44-4bec-9667-b37158450296")
  })

  it("claude-code outputHint ignores look-alike strings without the right shape", () => {
    const s = RESUME_STRATEGIES["claude-code"]!
    expect("foo bar".match(s.outputHint!)).toBeNull()
    // Too short to be a UUID
    expect("claude --resume abc".match(s.outputHint!)).toBeNull()
  })
})

describe("hasResumeStrategy", () => {
  it("true for adapters with declared hooks", () => {
    expect(hasResumeStrategy("claude-code")).toBe(true)
  })
  it("false for unknown / missing adapters", () => {
    expect(hasResumeStrategy("hermes")).toBe(false)
    expect(hasResumeStrategy(undefined)).toBe(false)
    expect(hasResumeStrategy("")).toBe(false)
  })
})

/**
 * fsProbe walks `~/.claude/projects/<encoded-cwd>/*.jsonl` and
 * returns the most-recent UUID, filtered by mtime ≥ startedAt. We
 * exercise it by faking a HOME with a few session files and varying
 * the startedAt filter.
 */
describe("claude-code fsProbe", () => {
  // Each test owns its own fake HOME so file fixtures don't bleed.
  let fakeHome: string
  let originalHome: string | undefined

  afterEach(() => {
    if (fakeHome) {
      rmSync(fakeHome, { recursive: true, force: true })
    }
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
  })

  function setupFakeHome(cwd: string): {
    home: string
    sessionsDir: string
  } {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "resume-strategies-"))
    process.env.HOME = fakeHome
    // claude encodes cwd as "/foo/bar" → "-foo-bar"
    const encoded = cwd.replace(/\//g, "-")
    const sessionsDir = join(fakeHome, ".claude", "projects", encoded)
    mkdirSync(sessionsDir, { recursive: true })
    return { home: fakeHome, sessionsDir }
  }

  function writeSession(dir: string, uuid: string, mtime: Date): void {
    const path = join(dir, `${uuid}.jsonl`)
    writeFileSync(path, "")
    // Force mtime to a known instant so the candidate-sort is
    // deterministic regardless of disk write latency.
    utimesSync(path, mtime, mtime)
  }

  it("returns the newest UUID within the cutoff", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    writeSession(sessionsDir, "aaaaaaaa-0000-0000-0000-000000000001", new Date("2026-05-13T10:00:00Z"))
    writeSession(sessionsDir, "bbbbbbbb-0000-0000-0000-000000000002", new Date("2026-05-13T12:00:00Z"))
    writeSession(sessionsDir, "cccccccc-0000-0000-0000-000000000003", new Date("2026-05-13T08:00:00Z"))
    // homedir() reads $HOME on macOS; the fsProbe uses it to compose
    // the path.
    expect(homedir()).toBe(fakeHome)
    const probe = RESUME_STRATEGIES["claude-code"]!.fsProbe!
    const found = await probe(cwd, "1970-01-01T00:00:00Z")
    expect(found).toBe("bbbbbbbb-0000-0000-0000-000000000002")
  })

  it("skips files older than startedAt", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    writeSession(sessionsDir, "old-aaaa-0000-0000-0000-000000000001", new Date("2026-05-13T08:00:00Z"))
    writeSession(sessionsDir, "new-bbbb-0000-0000-0000-000000000002", new Date("2026-05-13T12:00:00Z"))
    const probe = RESUME_STRATEGIES["claude-code"]!.fsProbe!
    // Cutoff at 10:00 — `old` is filtered out, `new` wins.
    const found = await probe(cwd, "2026-05-13T10:00:00Z")
    expect(found).toBe("new-bbbb-0000-0000-0000-000000000002")
  })

  it("returns null when no eligible files exist", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    writeSession(sessionsDir, "stale-0000-0000-0000-0000-000000000001", new Date("2026-05-13T08:00:00Z"))
    const probe = RESUME_STRATEGIES["claude-code"]!.fsProbe!
    // Cutoff past all writes → no eligible files.
    const found = await probe(cwd, "2026-05-14T00:00:00Z")
    expect(found).toBeNull()
  })

  it("returns null when the project directory doesn't exist", async () => {
    setupFakeHome("/unrelated/dir") // creates ~/.claude/projects/-unrelated-dir
    const probe = RESUME_STRATEGIES["claude-code"]!.fsProbe!
    // Probing a different cwd → no matching encoded dir.
    const found = await probe("/never/written", "1970-01-01T00:00:00Z")
    expect(found).toBeNull()
  })

  it("returns null when claude's project dir has no .jsonl files", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    // Write a non-jsonl marker — should be ignored.
    writeFileSync(join(sessionsDir, "README"), "")
    const probe = RESUME_STRATEGIES["claude-code"]!.fsProbe!
    const found = await probe(cwd, "1970-01-01T00:00:00Z")
    expect(found).toBeNull()
  })
})
