import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import {
  RESUME_STRATEGIES,
  hasResumeStrategy,
  decideRestartStrategy,
  augmentWithFsResume,
  describeResumePath,
  tokenizeCommand,
  type FsProbeCandidate,
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

/**
 * `decideRestartStrategy` is the shared decision tree ported from the
 * CLI's `buildRestartBody` — both `agentproto sessions restart` and the
 * daemon's `session_restart` MCP tool call this so they never diverge on
 * which resume path wins. Pin all four branches + the ordering between
 * them (pty-native beats pty-plain beats agent beats unsupported).
 */
describe("decideRestartStrategy", () => {
  it("picks pty-native when the adapter has a captured resume id + spawnArgs", () => {
    const strategy = decideRestartStrategy({
      adapterSlug: "claude-code",
      resumeMetadata: { claudeResumeId: "abc-123" },
    })
    expect(strategy).toEqual({
      kind: "pty-native",
      argv: ["claude", "--resume", "abc-123"],
    })
  })

  it("falls back to pty-plain for a real PTY session with no adapter match", () => {
    const strategy = decideRestartStrategy({ pty: true })
    expect(strategy).toEqual({ kind: "pty-plain" })
  })

  it("prefers pty-native over pty-plain when both could apply", () => {
    // A claude-code session that was ALSO run under a raw PTY (pty: true)
    // — native resume should still win since it's strictly more reliable.
    const strategy = decideRestartStrategy({
      adapterSlug: "claude-code",
      resumeMetadata: { claudeResumeId: "abc-123" },
      pty: true,
    })
    expect(strategy.kind).toBe("pty-native")
  })

  it("falls back to pty-plain when the adapter has no captured resume id yet", () => {
    // claude-code declares a strategy, but no id was ever captured for
    // this session (killed before the resume hint printed) — the pty:true
    // fallback wins, not the native one.
    const strategy = decideRestartStrategy({
      adapterSlug: "claude-code",
      pty: true,
    })
    expect(strategy).toEqual({ kind: "pty-plain" })
  })

  it("picks agent (ACP resume) for an agent-cli session with no native strategy", () => {
    const strategy = decideRestartStrategy({
      adapterSlug: "hermes",
      adapterSessionId: "chat_42",
    })
    expect(strategy).toEqual({ kind: "agent", resumeSessionId: "chat_42" })
  })

  it("agent strategy omits resumeSessionId when the adapter never persisted one", () => {
    const strategy = decideRestartStrategy({ adapterSlug: "hermes" })
    expect(strategy).toEqual({ kind: "agent" })
  })

  it("returns unsupported for a generic command session", () => {
    const strategy = decideRestartStrategy({})
    expect(strategy.kind).toBe("unsupported")
    if (strategy.kind === "unsupported") {
      expect(strategy.reason).toMatch(/generic command session/)
    }
  })
})

describe("describeResumePath", () => {
  it("describes a captured native resume id", () => {
    expect(
      describeResumePath({
        adapterSlug: "claude-code",
        resumeMetadata: { claudeResumeId: "abc-123" },
      }),
    ).toBe("resumed via claude --resume")
  })

  it("describes an ACP-level resume", () => {
    expect(
      describeResumePath({ adapterSlug: "hermes", adapterSessionId: "chat_42" }),
    ).toBe("resumed via ACP")
  })

  it("returns empty string when nothing was resumed", () => {
    expect(describeResumePath({})).toBe("")
    expect(describeResumePath({ adapterSlug: "hermes" })).toBe("")
  })
})

describe("tokenizeCommand", () => {
  it("splits on whitespace", () => {
    expect(tokenizeCommand("claude --resume abc-123")).toEqual([
      "claude",
      "--resume",
      "abc-123",
    ])
  })

  it("groups double-quoted segments containing spaces", () => {
    expect(tokenizeCommand(`bash -lc "echo hello world"`)).toEqual([
      "bash",
      "-lc",
      "echo hello world",
    ])
  })

  it("groups single-quoted segments containing spaces", () => {
    expect(tokenizeCommand(`claude --resume 'not a real uuid'`)).toEqual([
      "claude",
      "--resume",
      "not a real uuid",
    ])
  })
})

/**
 * `augmentWithFsResume` is the shared fs-probe fallback — restart
 * recovers continuity even when the output sniffer missed the resume
 * hint. Exercised end-to-end against a fake HOME (same technique as the
 * "claude-code fsProbe" suite above).
 */
describe("augmentWithFsResume", () => {
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

  function setupFakeHome(cwd: string): { sessionsDir: string } {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "resume-strategies-augment-"))
    process.env.HOME = fakeHome
    const encoded = cwd.replace(/\//g, "-")
    const sessionsDir = join(fakeHome, ".claude", "projects", encoded)
    mkdirSync(sessionsDir, { recursive: true })
    return { sessionsDir }
  }

  it("returns the same object when adapterSlug is unset", async () => {
    const prev = { startedAt: "2026-01-01T00:00:00Z" }
    await expect(augmentWithFsResume(prev)).resolves.toBe(prev)
  })

  it("returns the same object for an adapter with no fsProbe hook", async () => {
    const prev = { adapterSlug: "hermes", startedAt: "2026-01-01T00:00:00Z" }
    await expect(augmentWithFsResume(prev)).resolves.toBe(prev)
  })

  it("skips the fs probe when a resume id was already captured", async () => {
    // No fake HOME set up at all — if the probe ran, it would throw or
    // hit the real filesystem. The early return must short-circuit first.
    const prev = {
      adapterSlug: "claude-code",
      cwd: "/my/proj",
      startedAt: "2026-01-01T00:00:00Z",
      resumeMetadata: { claudeResumeId: "already-captured" },
    }
    await expect(augmentWithFsResume(prev)).resolves.toBe(prev)
  })

  it("returns the same object when cwd is unset", async () => {
    const prev = { adapterSlug: "claude-code", startedAt: "2026-01-01T00:00:00Z" }
    await expect(augmentWithFsResume(prev)).resolves.toBe(prev)
  })

  it("attaches the fs-probed id when the sniffer missed the resume hint", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const uuid = "ffffffff-0000-0000-0000-000000000099"
    writeFileSync(join(sessionsDir, `${uuid}.jsonl`), "")
    const prev: FsProbeCandidate = { adapterSlug: "claude-code", cwd, startedAt: "1970-01-01T00:00:00Z" }
    const result = await augmentWithFsResume(prev)
    expect(result).not.toBe(prev)
    expect(result.resumeMetadata).toEqual({ claudeResumeId: uuid })
  })

  it("returns the same object when the probe finds nothing eligible", async () => {
    const cwd = "/my/proj"
    setupFakeHome(cwd)
    const prev: FsProbeCandidate = { adapterSlug: "claude-code", cwd, startedAt: "1970-01-01T00:00:00Z" }
    await expect(augmentWithFsResume(prev)).resolves.toBe(prev)
  })

  it("preserves existing resumeMetadata keys when adding a new one", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const uuid = "aaaaaaaa-0000-0000-0000-000000000001"
    writeFileSync(join(sessionsDir, `${uuid}.jsonl`), "")
    const prev = {
      adapterSlug: "claude-code",
      cwd,
      startedAt: "1970-01-01T00:00:00Z",
      resumeMetadata: { hermesResumeId: "unrelated" },
    }
    const result = await augmentWithFsResume(prev)
    expect(result.resumeMetadata).toEqual({
      hermesResumeId: "unrelated",
      claudeResumeId: uuid,
    })
  })
})
