/**
 * Tests for conversation-store.ts — the claude-code ConversationStore.
 * No network, no live provider: fixtures are plain .jsonl files under a
 * fake $HOME (same technique as resume-strategies.test.ts).
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CONVERSATION_STORES,
  claudeCodeProjectDir,
  claudeProjectSlug,
  type ConversationStore,
  type ResumeMetadataKey,
} from "../conversation-store.js"

// ── claudeProjectSlug ────────────────────────────────────────────────
//
// The bug: the old encoder was `cwd.replace(/\//g, "-")` — slashes only.
// Claude Code's real rule replaces EVERY non-alnum character with "-",
// one-for-one, with no collapsing of consecutive runs. These cases are
// chosen to fail loudly under the old (wrong) implementation.

describe("claudeProjectSlug", () => {
  it("replaces slashes with dashes (the part the old encoder already got right)", () => {
    expect(claudeProjectSlug("/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio")).toBe(
      "-Volumes-SSDExternalMacStudio-Code-products-agentik-agentik-studio",
    )
  })

  it("does NOT collapse a dot immediately after a slash into one dash — this is the P1 bug", () => {
    // Old (wrong) encoder: cwd.replace(/\//g, "-") leaves the "." alone,
    // producing "-Users-jeremy-.agentproto-...". Real claude produces a
    // DOUBLE dash here: one for "/", one for ".", each character mapped
    // independently.
    const cwd = "/Users/jeremy/.agentproto/worktrees/ts/gc-fresh-hold"
    expect(claudeProjectSlug(cwd)).toBe(
      "-Users-jeremy--agentproto-worktrees-ts-gc-fresh-hold",
    )
  })

  it("real-world reconstruction #2: an underscore-prefixed worktree root", () => {
    // Live-verified against a real ~/.claude/projects/ directory name.
    const cwd = "/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/adapter-claude-sdk"
    expect(claudeProjectSlug(cwd)).toBe(
      "-Volumes-SSDExternalMacStudio-Code--agentproto-worktrees-adapter-claude-sdk",
    )
  })

  it("maps consecutive separators to the same count of dashes, never collapsed", () => {
    expect(claudeProjectSlug("/a//b")).toBe("-a--b")
    expect(claudeProjectSlug("/a///b")).toBe("-a---b")
  })

  it("maps a space to a single dash (e.g. macOS 'Application Support')", () => {
    expect(claudeProjectSlug("/Users/j/Library/Application Support/Claude")).toBe(
      "-Users-j-Library-Application-Support-Claude",
    )
  })

  it("preserves alphanumerics verbatim, including uppercase, digits, and existing dashes", () => {
    expect(claudeProjectSlug("/tmp/T3st-Dir_1")).toBe("-tmp-T3st-Dir-1")
  })

  it("leaves an already-dash-only path unchanged in shape (dash maps to dash)", () => {
    expect(claudeProjectSlug("/private/tmp")).toBe("-private-tmp")
  })
})

// ── interface shape ──────────────────────────────────────────────────

describe("CONVERSATION_STORES", () => {
  it("has a claude-code entry exposing storeAs/outputHint/attachArgv/discover/read", () => {
    const store: ConversationStore = CONVERSATION_STORES["claude-code"]!
    expect(store).toBeDefined()
    expect(store.storeAs).toBe("claudeResumeId")
    expect(store.outputHint).toBeInstanceOf(RegExp)
    expect(store.attachArgv).toBeTypeOf("function")
    expect(store.discover).toBeTypeOf("function")
    expect(store.read).toBeTypeOf("function")
  })

  it("re-exports ResumeMetadataKey from resume-strategies.ts (type-only, no drift)", () => {
    const key: ResumeMetadataKey = "claudeResumeId"
    expect(key).toBe("claudeResumeId")
  })

  it("attachArgv returns the claude --resume argv", () => {
    const store = CONVERSATION_STORES["claude-code"]!
    expect(store.attachArgv?.("X")).toEqual(["claude", "--resume", "X"])
  })
})

// ── discover ──────────────────────────────────────────────────────────

describe("claude-code discover", () => {
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
    fakeHome = mkdtempSync(join(tmpdir(), "conversation-store-"))
    process.env.HOME = fakeHome
    const encoded = cwd.replace(/\//g, "-")
    const sessionsDir = join(fakeHome, ".claude", "projects", encoded)
    mkdirSync(sessionsDir, { recursive: true })
    return { sessionsDir }
  }

  function writeJsonl(dir: string, uuid: string, lines: object[], mtime: Date): void {
    const path = join(dir, `${uuid}.jsonl`)
    const content = lines.length ? lines.map(l => JSON.stringify(l)).join("\n") + "\n" : ""
    writeFileSync(path, content)
    utimesSync(path, mtime, mtime)
  }

  it("returns [] (not a throw) when the project dir doesn't exist", async () => {
    setupFakeHome("/unrelated/dir")
    const store = CONVERSATION_STORES["claude-code"]!
    await expect(store.discover({ cwd: "/never/written" })).resolves.toEqual([])
  })

  it("returns [] (not a throw) when the project dir exists but is empty", async () => {
    const cwd = "/my/proj"
    setupFakeHome(cwd)
    const store = CONVERSATION_STORES["claude-code"]!
    await expect(store.discover({ cwd })).resolves.toEqual([])
  })

  // ── exact-bind (anti-cross-session-bug) ────────────────────────────

  it("exact-bind: returns exactly the expectedId candidate, even with a NEWER sibling present", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const own = "aaaaaaaa-0000-0000-0000-000000000001"
    const sibling = "bbbbbbbb-0000-0000-0000-000000000002"
    writeJsonl(
      sessionsDir,
      own,
      [
        {
          type: "user",
          timestamp: "2026-05-13T10:00:00.000Z",
          entrypoint: "sdk-ts",
          message: { role: "user", content: [{ type: "text", text: "hello own" }] },
        },
      ],
      new Date("2026-05-13T10:00:00Z"),
    )
    // Sibling is more recently modified — an mtime-latest guess would pick
    // it. expectedId must override that entirely, never even considering it.
    writeJsonl(
      sessionsDir,
      sibling,
      [
        {
          type: "user",
          timestamp: "2026-05-13T12:00:00.000Z",
          entrypoint: "cli",
          message: { role: "user", content: [{ type: "text", text: "hello sibling" }] },
        },
      ],
      new Date("2026-05-13T12:00:00Z"),
    )

    const store = CONVERSATION_STORES["claude-code"]!
    const found = await store.discover({ cwd, expectedId: own })
    expect(found).toHaveLength(1)
    expect(found[0]?.conversationId).toBe(own)
  })

  it("exact-bind: returns [] when the expectedId's transcript is absent — never a sibling's", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const sibling = "bbbbbbbb-0000-0000-0000-000000000002"
    writeJsonl(
      sessionsDir,
      sibling,
      [
        {
          type: "user",
          timestamp: "2026-05-13T12:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hello sibling" }] },
        },
      ],
      new Date("2026-05-13T12:00:00Z"),
    )
    const store = CONVERSATION_STORES["claude-code"]!
    const found = await store.discover({
      cwd,
      expectedId: "cccccccc-0000-0000-0000-000000000009",
    })
    expect(found).toEqual([])
  })

  // ── candidate enrichment (no expectedId) ───────────────────────────

  it("without expectedId, returns ALL candidates active at-or-after `since`, each enriched", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const idA = "aaaaaaaa-0000-0000-0000-000000000001"
    const idB = "bbbbbbbb-0000-0000-0000-000000000002"
    const idOld = "cccccccc-0000-0000-0000-000000000003"

    writeJsonl(
      sessionsDir,
      idA,
      [
        {
          type: "user",
          timestamp: "2026-05-13T10:00:00.000Z",
          entrypoint: "sdk-ts",
          message: { role: "user", content: [{ type: "text", text: "First message in A" }] },
        },
        {
          type: "assistant",
          timestamp: "2026-05-13T10:00:05.000Z",
          entrypoint: "sdk-ts",
          message: { role: "assistant", content: [{ type: "text", text: "Reply A" }] },
        },
      ],
      new Date("2026-05-13T10:00:05Z"),
    )

    writeJsonl(
      sessionsDir,
      idB,
      [
        {
          type: "user",
          timestamp: "2026-05-13T11:00:00.000Z",
          entrypoint: "sdk-ts",
          message: { role: "user", content: [{ type: "text", text: "First message in B" }] },
        },
        {
          type: "assistant",
          timestamp: "2026-05-13T11:05:00.000Z",
          entrypoint: "cli",
          message: { role: "assistant", content: [{ type: "text", text: "Reply B via native TUI" }] },
        },
      ],
      new Date("2026-05-13T11:05:00Z"),
    )

    // Older than the `since` cutoff below — must be excluded.
    writeJsonl(
      sessionsDir,
      idOld,
      [
        {
          type: "user",
          timestamp: "2026-05-13T01:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Old, before cutoff" }] },
        },
      ],
      new Date("2026-05-13T01:00:00Z"),
    )

    const store = CONVERSATION_STORES["claude-code"]!
    const found = await store.discover({ cwd, since: "2026-05-13T09:00:00Z" })

    expect(found.map(c => c.conversationId).sort()).toEqual([idA, idB].sort())

    const candB = found.find(c => c.conversationId === idB)
    expect(candB).toMatchObject({
      conversationId: idB,
      messageCount: 2,
      preview: "First message in B",
      lastWriter: "cli",
      startedAt: "2026-05-13T11:00:00.000Z",
      lastActivityAt: "2026-05-13T11:05:00.000Z",
    })

    const candA = found.find(c => c.conversationId === idA)
    expect(candA).toMatchObject({
      conversationId: idA,
      messageCount: 2,
      preview: "First message in A",
      lastWriter: "sdk-ts",
    })
  })

  it("without expectedId, excludes candidates entirely before `since`", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const idOld = "cccccccc-0000-0000-0000-000000000003"
    writeJsonl(
      sessionsDir,
      idOld,
      [
        {
          type: "user",
          timestamp: "2026-05-13T01:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Old" }] },
        },
      ],
      new Date("2026-05-13T01:00:00Z"),
    )
    const store = CONVERSATION_STORES["claude-code"]!
    const found = await store.discover({ cwd, since: "2026-05-14T00:00:00Z" })
    expect(found).toEqual([])
  })

  // ── `until` / `attachmentMode` narrowing (the sess_fea9b4f3 shape) ────

  it("narrows the sess_fea9b4f3 shape (1 real + 4 unrelated siblings) to exactly 1 via `until` OR `attachmentMode`, but not with neither", async () => {
    const cwd = "/repo/agentproto"
    const { sessionsDir } = setupFakeHome(cwd)
    const real = "c618de81-1016-45f7-bfe4-e24e2121f025"
    writeJsonl(
      sessionsDir,
      real,
      [
        {
          type: "user",
          timestamp: "2026-07-15T02:51:07.987Z",
          entrypoint: "cli",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        },
      ],
      new Date("2026-07-15T02:51:07.987Z"),
    )

    const siblings = [
      "11111111-0000-0000-0000-000000000001",
      "22222222-0000-0000-0000-000000000002",
      "33333333-0000-0000-0000-000000000003",
      "44444444-0000-0000-0000-000000000004",
    ]
    for (const sib of siblings) {
      writeJsonl(
        sessionsDir,
        sib,
        [
          {
            type: "user",
            timestamp: "2026-07-16T09:00:00.000Z",
            entrypoint: "sdk-ts",
            message: { role: "user", content: [{ type: "text", text: "unrelated, written a day later" }] },
          },
        ],
        new Date("2026-07-16T09:00:00.000Z"),
      )
    }

    const store = CONVERSATION_STORES["claude-code"]!

    // Neither filter: still ambiguous — proves narrowing isn't hardcoded.
    const withNeither = await store.discover({ cwd })
    expect(withNeither.map(c => c.conversationId).sort()).toEqual([real, ...siblings].sort())

    // `until` = the dead session's endedAt: the 4 siblings started AFTER
    // the session ended, so they're provably not its conversation.
    const withUntil = await store.discover({ cwd, until: "2026-07-15T03:17:21.000Z" })
    expect(withUntil.map(c => c.conversationId)).toEqual([real])

    // `attachmentMode: "native"` alone: the 4 siblings are sdk-ts (ACP),
    // a native PTY's conversation can't be one of them.
    const withMode = await store.discover({ cwd, attachmentMode: "native" })
    expect(withMode.map(c => c.conversationId)).toEqual([real])
  })

  it("`until` never drops a candidate with no discoverable startedAt (conservative)", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const noTimestamp = "dddddddd-0000-0000-0000-000000000004"
    // No `timestamp` field on the line at all — scanClaudeJsonl can't
    // derive a startedAt for it.
    writeJsonl(
      sessionsDir,
      noTimestamp,
      [{ type: "user", message: { role: "user", content: [{ type: "text", text: "no ts" }] } }],
      new Date("2026-05-13T10:00:00Z"),
    )
    const store = CONVERSATION_STORES["claude-code"]!
    const found = await store.discover({ cwd, until: "2020-01-01T00:00:00.000Z" })
    expect(found.map(c => c.conversationId)).toEqual([noTimestamp])
  })

  it("`attachmentMode` never drops a candidate with no lastWriter (conservative)", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const noEntrypoint = "eeeeeeee-0000-0000-0000-000000000005"
    writeJsonl(
      sessionsDir,
      noEntrypoint,
      [
        {
          type: "user",
          timestamp: "2026-05-13T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "no entrypoint" }] },
        },
      ],
      new Date("2026-05-13T10:00:00Z"),
    )
    const store = CONVERSATION_STORES["claude-code"]!
    const found = await store.discover({ cwd, attachmentMode: "acp" })
    expect(found.map(c => c.conversationId)).toEqual([noEntrypoint])
  })

  it("exact-bind (expectedId) ignores `until`/`attachmentMode` entirely", async () => {
    const cwd = "/my/proj"
    const { sessionsDir } = setupFakeHome(cwd)
    const own = "aaaaaaaa-0000-0000-0000-000000000009"
    writeJsonl(
      sessionsDir,
      own,
      [
        {
          type: "user",
          timestamp: "2026-07-16T09:00:00.000Z",
          entrypoint: "sdk-ts",
          message: { role: "user", content: [{ type: "text", text: "own, would fail both filters" }] },
        },
      ],
      new Date("2026-07-16T09:00:00Z"),
    )
    const store = CONVERSATION_STORES["claude-code"]!
    // startedAt is AFTER `until`, and lastWriter is the opposite of
    // `attachmentMode` — either filter alone would drop this candidate if
    // it applied to the expectedId path. It must not.
    const found = await store.discover({
      cwd,
      expectedId: own,
      until: "2020-01-01T00:00:00.000Z",
      attachmentMode: "native",
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.conversationId).toBe(own)
  })
})

// ── read ──────────────────────────────────────────────────────────────

describe("claude-code read", () => {
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

  it("delegates to the shared exportClaudeCodeSession parser", async () => {
    const cwd = "/test/project"
    const encoded = cwd.replace(/\//g, "-")
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "conversation-store-read-"))
    process.env.HOME = fakeHome

    const dir = join(fakeHome, ".claude", "projects", encoded)
    mkdirSync(dir, { recursive: true })
    const uuid = "abc12345-0000-0000-0000-000000000001"
    writeFileSync(
      join(dir, `${uuid}.jsonl`),
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-13T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }) + "\n",
    )

    const store = CONVERSATION_STORES["claude-code"]!
    const session = await store.read(uuid, cwd)
    expect(session.meta.source).toBe("claude-code")
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({ role: "user", text: "hi" })
  })

  it("surfaces the exporter's own error for a missing transcript", async () => {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "conversation-store-read-missing-"))
    process.env.HOME = fakeHome

    const store = CONVERSATION_STORES["claude-code"]!
    await expect(store.read("does-not-exist", "/nowhere")).rejects.toThrow(/not found/)
  })
})

// ── config-dir isolation (#824) ──────────────────────────────────────
//
// Since the MCP-isolation fix, a daemon-spawned claude-code session runs
// with its own CLAUDE_CONFIG_DIR and the SDK mirrors the global layout
// under it: <configDir>/projects/<slug>/<uuid>.jsonl. Discovery and read
// must look THERE when the caller passes the session's config dir — and
// keep resolving ~/.claude when it doesn't (native PTY / pre-#824 rows).

describe("claude-code config-dir isolation", () => {
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

  /** A fake HOME plus an isolated config dir OUTSIDE ~/.claude — mirrors
   *  the real ~/.agentproto/adapter-config/<sess>/ shape. */
  function setupIsolated(cwd: string): {
    configDir: string
    isolatedSessionsDir: string
    globalSessionsDir: string
  } {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "conversation-store-configdir-"))
    process.env.HOME = fakeHome
    const encoded = cwd.replace(/\//g, "-")
    const configDir = join(fakeHome, ".agentproto", "adapter-config", "sess_test")
    const isolatedSessionsDir = join(configDir, "projects", encoded)
    const globalSessionsDir = join(fakeHome, ".claude", "projects", encoded)
    mkdirSync(isolatedSessionsDir, { recursive: true })
    mkdirSync(globalSessionsDir, { recursive: true })
    return { configDir, isolatedSessionsDir, globalSessionsDir }
  }

  function writeJsonl(dir: string, uuid: string, mtime: Date): void {
    const path = join(dir, `${uuid}.jsonl`)
    writeFileSync(
      path,
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-07T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }) + "\n",
    )
    utimesSync(path, mtime, mtime)
  }

  it("claudeCodeProjectDir resolves under configDir when given, ~/.claude otherwise", () => {
    const cwd = "/my/proj"
    const { configDir } = setupIsolated(cwd)
    expect(claudeCodeProjectDir(cwd, configDir)).toBe(join(configDir, "projects", "-my-proj"))
    expect(claudeCodeProjectDir(cwd)).toBe(join(fakeHome, ".claude", "projects", "-my-proj"))
  })

  it("discover({configDir}) finds a transcript that lives ONLY in the isolated dir", async () => {
    const cwd = "/my/proj"
    const { configDir, isolatedSessionsDir } = setupIsolated(cwd)
    const uuid = "aaaaaaaa-0000-0000-0000-000000000001"
    writeJsonl(isolatedSessionsDir, uuid, new Date("2026-08-07T10:00:00Z"))
    const store = CONVERSATION_STORES["claude-code"]!
    // The bug this pins: without configDir the isolated transcript is
    // invisible — discovery searched ~/.claude only.
    await expect(store.discover({ cwd })).resolves.toEqual([])
    const found = await store.discover({ cwd, configDir })
    expect(found.map(c => c.conversationId)).toEqual([uuid])
  })

  it("discover({configDir, expectedId}) exact-binds inside the isolated dir", async () => {
    const cwd = "/my/proj"
    const { configDir, isolatedSessionsDir } = setupIsolated(cwd)
    const own = "aaaaaaaa-0000-0000-0000-000000000001"
    const sibling = "bbbbbbbb-0000-0000-0000-000000000002"
    writeJsonl(isolatedSessionsDir, own, new Date("2026-08-07T10:00:00Z"))
    writeJsonl(isolatedSessionsDir, sibling, new Date("2026-08-07T12:00:00Z"))
    const store = CONVERSATION_STORES["claude-code"]!
    const found = await store.discover({ cwd, configDir, expectedId: own })
    expect(found.map(c => c.conversationId)).toEqual([own])
  })

  it("discover WITHOUT configDir keeps resolving ~/.claude (native PTY / pre-#824 sessions)", async () => {
    const cwd = "/my/proj"
    const { globalSessionsDir } = setupIsolated(cwd)
    const uuid = "cccccccc-0000-0000-0000-000000000003"
    writeJsonl(globalSessionsDir, uuid, new Date("2026-08-07T10:00:00Z"))
    const store = CONVERSATION_STORES["claude-code"]!
    const found = await store.discover({ cwd })
    expect(found.map(c => c.conversationId)).toEqual([uuid])
  })

  it("read(id, cwd, configDir) reads the transcript from the isolated dir", async () => {
    const cwd = "/my/proj"
    const { configDir, isolatedSessionsDir } = setupIsolated(cwd)
    const uuid = "dddddddd-0000-0000-0000-000000000004"
    writeJsonl(isolatedSessionsDir, uuid, new Date("2026-08-07T10:00:00Z"))
    const store = CONVERSATION_STORES["claude-code"]!
    // Without configDir the read misses (file isn't under ~/.claude)…
    await expect(store.read(uuid, cwd)).rejects.toThrow(/not found/)
    // …with it, the isolated transcript reads normally.
    const session = await store.read(uuid, cwd, configDir)
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({ role: "user", text: "hi" })
  })
})
