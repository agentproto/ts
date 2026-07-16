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
  type ConversationStore,
  type ResumeMetadataKey,
} from "../conversation-store.js"

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
