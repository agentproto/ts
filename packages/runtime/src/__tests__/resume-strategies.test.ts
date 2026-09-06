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
    expect(hasResumeStrategy("hermes")).toBe(true)
  })
  it("false for unknown / missing adapters", () => {
    expect(hasResumeStrategy("codex")).toBe(false)
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

  // ── expectedId binding (cross-session resume safety) ─────────────
  //
  // When the caller knows the session's own conversation id (agent-cli
  // descriptors carry it as `adapterSessionId`; for claude-code it IS
  // the .jsonl uuid), the probe must bind to THAT transcript exactly —
  // never the most-recently modified one, which may belong to a
  // concurrent, unrelated session sharing the same cwd. This is the
  // root-cause regression: mtime-latest silently resumed the wrong
  // conversation.

  it("binds to <expectedId>.jsonl when the id is known, ignoring a NEWER sibling in the same cwd", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const own = "aaaaaaaa-0000-0000-0000-000000000001"
    const sibling = "bbbbbbbb-0000-0000-0000-000000000002"
    // The session's own transcript is OLDER than the sibling's — under
    // mtime-latest the sibling would win. expectedId must override that.
    writeSession(sessionsDir, own, new Date("2026-05-13T10:00:00Z"))
    writeSession(sessionsDir, sibling, new Date("2026-05-13T12:00:00Z"))
    const probe = RESUME_STRATEGIES["claude-code"]!.fsProbe!
    const found = await probe(cwd, "1970-01-01T00:00:00Z", own)
    expect(found).toBe(own)
  })

  it("returns null when the known id's transcript is absent — never a sibling's", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const sibling = "bbbbbbbb-0000-0000-0000-000000000002"
    writeSession(sessionsDir, sibling, new Date("2026-05-13T12:00:00Z"))
    const probe = RESUME_STRATEGIES["claude-code"]!.fsProbe!
    // Own transcript is gone: refuse to guess, even though a newer
    // sibling exists. Caller falls back to ACP resume against the real
    // id, which can 404 → fresh spawn — but never resumes the sibling.
    const found = await probe(cwd, "1970-01-01T00:00:00Z", "cccccccc-0000-0000-0000-000000000009")
    expect(found).toBeNull()
  })

  it("ignores the startedAt cutoff when binding to a known id (its own transcript is always eligible)", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const own = "aaaaaaaa-0000-0000-0000-000000000001"
    // Written BEFORE the session's own startedAt would be — the mtime
    // filter is a heuristic to avoid unrelated priors; it's irrelevant
    // once we're targeting the session's own file by id.
    writeSession(sessionsDir, own, new Date("2026-05-13T08:00:00Z"))
    const probe = RESUME_STRATEGIES["claude-code"]!.fsProbe!
    const found = await probe(cwd, "2026-05-13T12:00:00Z", own)
    expect(found).toBe(own)
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
  it("picks pty-native for a PTY-origin session with a captured resume id + spawnArgs + nativeTerminalResume", () => {
    const strategy = decideRestartStrategy({
      adapterSlug: "claude-code",
      resumeMetadata: { claudeResumeId: "abc-123" },
      nativeTerminalResume: true,
      pty: true,
    })
    expect(strategy).toEqual({
      kind: "pty-native",
      argv: ["claude", "--resume", "abc-123"],
    })
  })

  // ── origin gate (root-cause fix: "restart starts a terminal but it
  // doesn't work") ──────────────────────────────────────────────────
  //
  // An agent-cli/ACP-origin session's isolated CLAUDE_CONFIG_DIR is
  // populated ONLY by the headless ACP entrypoint, which never runs
  // claude-code's interactive first-run wizard (theme picker, "detected a
  // custom API key" prompt) — so a DEFAULT pty-native restart of such a
  // session silently drops it onto that wizard with no one attached to
  // answer it. `nativeTerminalResume` is a capability declaration, not
  // license to mode-switch a headless session into an unattended terminal.

  it("an ACP-origin session (prev.pty not true) does NOT get pty-native by default, even with nativeTerminalResume + a captured id — resumes via agent/ACP instead", () => {
    const strategy = decideRestartStrategy({
      adapterSlug: "claude-code",
      resumeMetadata: { claudeResumeId: "abc-123" },
      nativeTerminalResume: true,
      adapterSessionId: "acp-session-1",
    })
    expect(strategy).toEqual({ kind: "agent", resumeSessionId: "acp-session-1" })
  })

  it("preferNativeTerminal:true opts an ACP-origin session INTO pty-native", () => {
    const strategy = decideRestartStrategy(
      {
        adapterSlug: "claude-code",
        resumeMetadata: { claudeResumeId: "abc-123" },
        nativeTerminalResume: true,
        adapterSessionId: "acp-session-1",
      },
      { preferNativeTerminal: true },
    )
    expect(strategy).toEqual({
      kind: "pty-native",
      argv: ["claude", "--resume", "abc-123"],
    })
  })

  it("preferNativeTerminal is irrelevant (and unnecessary) for a genuinely PTY-origin session", () => {
    const strategy = decideRestartStrategy(
      {
        adapterSlug: "claude-code",
        resumeMetadata: { claudeResumeId: "abc-123" },
        nativeTerminalResume: true,
        pty: true,
      },
      { preferNativeTerminal: false },
    )
    expect(strategy.kind).toBe("pty-native")
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
      nativeTerminalResume: true,
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
      nativeTerminalResume: true,
    })
    expect(strategy).toEqual({ kind: "pty-plain" })
  })

  it("picks agent (ACP resume) for an agent-cli session with no native terminal capability", () => {
    // Hermes now has a store entry, but without nativeTerminalResume the
    // daemon must not restart it as a raw PTY — ACP/agent is the only path.
    const strategy = decideRestartStrategy({
      adapterSlug: "hermes",
      adapterSessionId: "chat_42",
    })
    expect(strategy).toEqual({ kind: "agent", resumeSessionId: "chat_42" })
  })

  it("picks pty-native for a PTY-origin hermes session when nativeTerminalResume is set and a resume id is captured", () => {
    const strategy = decideRestartStrategy({
      adapterSlug: "hermes",
      resumeMetadata: { hermesResumeId: "h-1" },
      nativeTerminalResume: true,
      pty: true,
    })
    expect(strategy).toEqual({
      kind: "pty-native",
      argv: ["hermes", "--resume", "h-1", "--tui"],
    })
  })

  it("agent strategy omits resumeSessionId when the adapter never persisted one", () => {
    const strategy = decideRestartStrategy({ adapterSlug: "hermes" })
    expect(strategy).toEqual({ kind: "agent" })
  })

  // ── resume-honesty fix: capability-based downgrade ──────────────────
  //
  // An adapter that declares `resumable: false` (hermes, mastra-agent, …)
  // cannot rehydrate a prior conversation from `adapterSessionId` at all —
  // this was the silent-blank-session bug (`describeResumePath` used to
  // report "resumed via ACP" regardless of capability). The decision tree
  // must never hand back a phantom `resumeSessionId` for one of these, and
  // must flag the downgrade so callers stamp `resumeFallback: true`.

  it("resumable:false never emits resumeSessionId, even with a captured adapterSessionId — flags resumeFallback instead", () => {
    const strategy = decideRestartStrategy({
      adapterSlug: "hermes",
      adapterSessionId: "chat_42",
      resumable: false,
    })
    expect(strategy).toEqual({ kind: "agent", resumeFallback: true })
  })

  it("resumable:false with no captured id at all is just the ordinary empty case (nothing to downgrade)", () => {
    const strategy = decideRestartStrategy({
      adapterSlug: "hermes",
      resumable: false,
    })
    expect(strategy).toEqual({ kind: "agent" })
  })

  it("resumable:true (or unknown) is unaffected — unchanged behaviour", () => {
    expect(
      decideRestartStrategy({
        adapterSlug: "hermes",
        adapterSessionId: "chat_42",
        resumable: true,
      }),
    ).toEqual({ kind: "agent", resumeSessionId: "chat_42" })
    expect(
      decideRestartStrategy({
        adapterSlug: "hermes",
        adapterSessionId: "chat_42",
      }),
    ).toEqual({ kind: "agent", resumeSessionId: "chat_42" })
  })

  it("claude-code's pty-native happy path is unaffected by resumable:false (nativeTerminalResume governs pty-native, not resumable)", () => {
    const strategy = decideRestartStrategy({
      adapterSlug: "claude-code",
      resumeMetadata: { claudeResumeId: "abc-123" },
      resumable: false,
      nativeTerminalResume: true,
      pty: true,
    })
    expect(strategy).toEqual({
      kind: "pty-native",
      argv: ["claude", "--resume", "abc-123"],
    })
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
  it("describes a captured native resume id (PTY-origin session)", () => {
    expect(
      describeResumePath({
        adapterSlug: "claude-code",
        resumeMetadata: { claudeResumeId: "abc-123" },
        pty: true,
      }),
    ).toBe("resumed via claude --resume")
  })

  it("describes a captured native resume id via the preferNativeTerminal opt-in (ACP-origin session)", () => {
    expect(
      describeResumePath(
        {
          adapterSlug: "claude-code",
          resumeMetadata: { claudeResumeId: "abc-123" },
        },
        { preferNativeTerminal: true },
      ),
    ).toBe("resumed via claude --resume")
  })

  it("an ACP-origin session with a captured native id but NO opt-in describes ACP resume, not the native label (origin gate)", () => {
    expect(
      describeResumePath({
        adapterSlug: "claude-code",
        resumeMetadata: { claudeResumeId: "abc-123" },
        adapterSessionId: "acp-session-1",
      }),
    ).toBe("resumed via ACP")
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

  // ── resume-honesty fix ────────────────────────────────────────────
  it("never claims 'resumed via ACP' for a resumable:false adapter — honest degraded label instead", () => {
    expect(
      describeResumePath({
        adapterSlug: "hermes",
        adapterSessionId: "chat_42",
        resumable: false,
      }),
    ).toBe("fresh — resume not supported by hermes")
  })

  it("claude-code (resumable:true) keeps saying 'resumed via ACP' when it takes the ACP branch", () => {
    // claude-code normally resolves pty-native (see the describe block
    // above) — this pins the ACP branch specifically stays truthful when
    // resumable is explicitly true, unaffected by the honesty gate.
    expect(
      describeResumePath({
        adapterSlug: "claude-code",
        adapterSessionId: "acp-abc",
        resumable: true,
      }),
    ).toBe("resumed via ACP")
  })

  it("resumable:true or unknown for a no-native-strategy adapter is unaffected — still 'resumed via ACP'", () => {
    expect(
      describeResumePath({ adapterSlug: "hermes", adapterSessionId: "chat_42", resumable: true }),
    ).toBe("resumed via ACP")
    expect(
      describeResumePath({ adapterSlug: "hermes", adapterSessionId: "chat_42" }),
    ).toBe("resumed via ACP")
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

  it("backfills adapterSessionId from fsProbe when it was never captured", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const uuid = "ffffffff-0000-0000-0000-000000000099"
    writeFileSync(join(sessionsDir, `${uuid}.jsonl`), "")
    const prev: FsProbeCandidate = { adapterSlug: "claude-code", cwd, startedAt: "1970-01-01T00:00:00Z" }
    const result = await augmentWithFsResume(prev)
    expect(result.adapterSessionId).toBe(uuid)
  })

  it("does not overwrite an existing adapterSessionId with the fsProbe result", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const own = "aaaaaaaa-0000-0000-0000-000000000001"
    writeFileSync(join(sessionsDir, `${own}.jsonl`), "")
    const prev: FsProbeCandidate = {
      adapterSlug: "claude-code",
      cwd,
      startedAt: "1970-01-01T00:00:00Z",
      adapterSessionId: own,
    }
    const result = await augmentWithFsResume(prev)
    expect(result.adapterSessionId).toBe(own)
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

  // The core bug: a killed agent-cli claude-code session (empty ring
  // buffer → sniffer never captured claudeResumeId) is restarted while a
  // concurrent, unrelated claude session is actively writing its own
  // transcript in the SAME cwd. augment must bind to the dead session's
  // own adapterSessionId — never the newer sibling.
  it("binds resumeMetadata to adapterSessionId, not the newest sibling in the cwd", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const own = "aaaaaaaa-0000-0000-0000-000000000001"
    const sibling = "bbbbbbbb-0000-0000-0000-000000000002"
    const ownFile = join(sessionsDir, `${own}.jsonl`)
    const siblingFile = join(sessionsDir, `${sibling}.jsonl`)
    writeFileSync(ownFile, "")
    writeFileSync(siblingFile, "")
    // Sibling is more recently modified — mtime-latest would pick it.
    utimesSync(ownFile, new Date("2026-05-13T10:00:00Z"), new Date("2026-05-13T10:00:00Z"))
    utimesSync(siblingFile, new Date("2026-05-13T12:00:00Z"), new Date("2026-05-13T12:00:00Z"))
    const prev: FsProbeCandidate = {
      adapterSlug: "claude-code",
      cwd,
      startedAt: "1970-01-01T00:00:00Z",
      adapterSessionId: own,
    }
    const result = await augmentWithFsResume(prev)
    expect(result.resumeMetadata).toEqual({ claudeResumeId: own })
  })

  it("returns prev unchanged when adapterSessionId's transcript is gone (falls back to ACP resume, never a sibling)", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    // Only a sibling's transcript exists on disk.
    writeFileSync(join(sessionsDir, "bbbbbbbb-0000-0000-0000-000000000002.jsonl"), "")
    const prev: FsProbeCandidate = {
      adapterSlug: "claude-code",
      cwd,
      startedAt: "1970-01-01T00:00:00Z",
      adapterSessionId: "aaaaaaaa-0000-0000-0000-000000000001",
    }
    // No claudeResumeId attached → decideRestartStrategy takes the `agent`
    // branch and resumes at the ACP level via the real adapterSessionId.
    await expect(augmentWithFsResume(prev)).resolves.toBe(prev)
  })
})

/**
 * Config-dir isolation (#824): a daemon-spawned claude-code session runs
 * with its own CLAUDE_CONFIG_DIR, so its transcript lives under
 * `<adapterConfigDir>/projects/<slug>/` — NOT `~/.claude/projects/<slug>/`.
 * The fs probe must look in the isolated dir when the descriptor carries
 * `adapterConfigDir`, and keep probing ~/.claude when it doesn't (native
 * PTY / pre-#824 rows). This was the 100%-broken-native-resume bug: the
 * probe never found the isolated transcript, `claudeResumeId` never got
 * populated, and every daemon restart fell back to the truncated digest.
 */
describe("augmentWithFsResume with an isolated adapterConfigDir", () => {
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

  /** Fake HOME + an isolated config dir shaped like the real
   *  ~/.agentproto/adapter-config/<sess>/ tree. Both project dirs exist;
   *  each test chooses where to write the transcript. */
  function setupIsolated(cwd: string): {
    configDir: string
    isolatedSessionsDir: string
    globalSessionsDir: string
  } {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "resume-strategies-configdir-"))
    process.env.HOME = fakeHome
    const encoded = cwd.replace(/\//g, "-")
    const configDir = join(fakeHome, ".agentproto", "adapter-config", "sess_test")
    const isolatedSessionsDir = join(configDir, "projects", encoded)
    const globalSessionsDir = join(fakeHome, ".claude", "projects", encoded)
    mkdirSync(isolatedSessionsDir, { recursive: true })
    mkdirSync(globalSessionsDir, { recursive: true })
    return { configDir, isolatedSessionsDir, globalSessionsDir }
  }

  it("fsProbe(…, configDir) exact-binds a transcript that exists ONLY in the isolated dir", async () => {
    const cwd = "/my/proj"
    const { configDir, isolatedSessionsDir } = setupIsolated(cwd)
    const own = "aaaaaaaa-0000-0000-0000-000000000001"
    writeFileSync(join(isolatedSessionsDir, `${own}.jsonl`), "")
    const probe = RESUME_STRATEGIES["claude-code"]!.fsProbe!
    // Without the config dir the probe searches ~/.claude and misses —
    // the exact regression this suite pins.
    await expect(probe(cwd, "1970-01-01T00:00:00Z", own)).resolves.toBeNull()
    await expect(probe(cwd, "1970-01-01T00:00:00Z", own, configDir)).resolves.toBe(own)
  })

  it("attaches claudeResumeId from the isolated dir when the descriptor carries adapterConfigDir", async () => {
    const cwd = "/my/proj"
    const { configDir, isolatedSessionsDir } = setupIsolated(cwd)
    const own = "bbbbbbbb-0000-0000-0000-000000000002"
    writeFileSync(join(isolatedSessionsDir, `${own}.jsonl`), "")
    const prev: FsProbeCandidate = {
      adapterSlug: "claude-code",
      cwd,
      startedAt: "1970-01-01T00:00:00Z",
      adapterSessionId: own,
      adapterConfigDir: configDir,
    }
    const result = await augmentWithFsResume(prev)
    expect(result.resumeMetadata).toEqual({ claudeResumeId: own })
  })

  it("without adapterConfigDir the probe keeps finding legacy transcripts under ~/.claude", async () => {
    const cwd = "/my/proj"
    const { globalSessionsDir } = setupIsolated(cwd)
    const own = "cccccccc-0000-0000-0000-000000000003"
    writeFileSync(join(globalSessionsDir, `${own}.jsonl`), "")
    const prev: FsProbeCandidate = {
      adapterSlug: "claude-code",
      cwd,
      startedAt: "1970-01-01T00:00:00Z",
      adapterSessionId: own,
    }
    const result = await augmentWithFsResume(prev)
    expect(result.resumeMetadata).toEqual({ claudeResumeId: own })
  })

  it("an isolated session's probe never falls back to a ~/.claude sibling (cross-session safety)", async () => {
    const cwd = "/my/proj"
    const { configDir, globalSessionsDir } = setupIsolated(cwd)
    // A sibling conversation in the GLOBAL store shares the cwd — it must
    // never be picked up for a config-dir-isolated session.
    writeFileSync(join(globalSessionsDir, "dddddddd-0000-0000-0000-000000000004.jsonl"), "")
    const prev: FsProbeCandidate = {
      adapterSlug: "claude-code",
      cwd,
      startedAt: "1970-01-01T00:00:00Z",
      adapterConfigDir: configDir,
    }
    await expect(augmentWithFsResume(prev)).resolves.toBe(prev)
  })
})
