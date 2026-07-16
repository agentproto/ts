/**
 * Tests for conversation-store.ts's hermes ConversationStore.
 * Sqlite fixtures live under a fake $HOME (same technique as
 * conversation-store.test.ts's claude-code fixtures — set $HOME, no
 * os.homedir() mock needed). Sqlite-dependent describe blocks are gated
 * on node:sqlite actually being importable, mirroring transcript-export.ts's
 * own "Requires Node.js ≥22.5.0" guard — they skip cleanly on older Node
 * instead of failing at import time.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONVERSATION_STORES, type ConversationStore } from "../conversation-store.js"

let sqliteAvailable = true
let DatabaseSyncCtor: (typeof import("node:sqlite"))["DatabaseSync"] | undefined
try {
  const sqlite = await import("node:sqlite")
  DatabaseSyncCtor = sqlite.DatabaseSync
} catch {
  sqliteAvailable = false
}

// ── interface shape ──────────────────────────────────────────────────

describe("CONVERSATION_STORES hermes entry", () => {
  it("has a hermes entry exposing storeAs/attachArgv/discover/read", () => {
    const store: ConversationStore = CONVERSATION_STORES["hermes"]!
    expect(store).toBeDefined()
    expect(store.storeAs).toBe("hermesResumeId")
    expect(store.attachArgv).toBeTypeOf("function")
    expect(store.discover).toBeTypeOf("function")
    expect(store.read).toBeTypeOf("function")
  })

  it("attachArgv returns the hermes --resume --tui argv", () => {
    const store = CONVERSATION_STORES["hermes"]!
    expect(store.attachArgv?.("X")).toEqual(["hermes", "--resume", "X", "--tui"])
  })

  it("omits outputHint and follow — no verified live pattern today", () => {
    const store = CONVERSATION_STORES["hermes"]!
    expect(store.outputHint).toBeUndefined()
    expect(store.follow).toBeUndefined()
  })
})

// ── discover (sqlite) ────────────────────────────────────────────────

describe.skipIf(!sqliteAvailable)("hermes discover", () => {
  let fakeHome: string
  let originalHome: string | undefined
  const CWD = "/my/hermes/proj"

  function setupFakeHome(): void {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "conversation-store-hermes-"))
    process.env.HOME = fakeHome
    mkdirSync(join(fakeHome, ".hermes"), { recursive: true })
  }

  function makeDb() {
    const DatabaseSync = DatabaseSyncCtor!
    const db = new DatabaseSync(join(fakeHome, ".hermes", "state.db"))
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, model TEXT, cwd TEXT,
        git_branch TEXT, git_repo_root TEXT,
        started_at REAL, ended_at REAL,
        message_count INTEGER, source TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp INTEGER
      );
    `)
    return db
  }

  function insertSession(
    db: ReturnType<typeof makeDb>,
    row: {
      id: string
      cwd: string
      title?: string
      startedAt: number
      endedAt?: number
      messageCount?: number
      source?: string
    },
  ): void {
    db.prepare(
      `INSERT INTO sessions (id, title, cwd, started_at, ended_at, message_count, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.title ?? null,
      row.cwd,
      row.startedAt,
      row.endedAt ?? null,
      row.messageCount ?? null,
      row.source ?? null,
    )
  }

  afterEach(() => {
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it("returns [] (not a throw) when state.db doesn't exist", async () => {
    setupFakeHome()
    const store = CONVERSATION_STORES["hermes"]!
    await expect(store.discover({ cwd: CWD })).resolves.toEqual([])
  })

  // ── exact-bind (anti-cross-session-bug) ────────────────────────────

  it("exact-bind: returns exactly the expectedId candidate, even with a sibling in the same cwd", async () => {
    setupFakeHome()
    const db = makeDb()
    const own = "own-session-0001"
    const sibling = "sibling-session-0002"
    insertSession(db, { id: own, cwd: CWD, title: "own session", startedAt: 1748000000 })
    // Sibling shares the cwd and started later — an mtime/recency-style
    // guess would prefer it. expectedId must override that entirely.
    insertSession(db, {
      id: sibling,
      cwd: CWD,
      title: "sibling session",
      startedAt: 1748010000,
    })
    db.close()

    const store = CONVERSATION_STORES["hermes"]!
    const found = await store.discover({ cwd: CWD, expectedId: own })
    expect(found).toHaveLength(1)
    expect(found[0]?.conversationId).toBe(own)
  })

  it("exact-bind: returns [] when the expectedId's row is absent — never a sibling's", async () => {
    setupFakeHome()
    const db = makeDb()
    insertSession(db, { id: "sibling-session-0002", cwd: CWD, startedAt: 1748000000 })
    db.close()

    const store = CONVERSATION_STORES["hermes"]!
    const found = await store.discover({ cwd: CWD, expectedId: "does-not-exist" })
    expect(found).toEqual([])
  })

  it("exact-bind ignores cwd entirely — id lookup is cwd-independent", async () => {
    setupFakeHome()
    const db = makeDb()
    const id = "cross-cwd-session"
    insertSession(db, { id, cwd: "/some/other/proj", startedAt: 1748000000 })
    db.close()

    const store = CONVERSATION_STORES["hermes"]!
    const found = await store.discover({ cwd: CWD, expectedId: id })
    expect(found).toHaveLength(1)
    expect(found[0]?.conversationId).toBe(id)
  })

  // ── cwd-scoped discovery without expectedId ─────────────────────────

  it("without expectedId, returns ALL cwd-scoped candidates active at-or-after `since`, enriched", async () => {
    setupFakeHome()
    const db = makeDb()
    const idA = "sess-a"
    const idB = "sess-b"
    const idOld = "sess-old"
    const idOther = "sess-other-cwd"
    insertSession(db, {
      id: idA,
      cwd: CWD,
      title: "First conversation",
      startedAt: 1748000000,
      endedAt: 1748000500,
      messageCount: 4,
      source: "acp",
    })
    insertSession(db, {
      id: idB,
      cwd: CWD,
      title: "Second conversation",
      startedAt: 1748001000,
      messageCount: 2,
      source: "cli",
    })
    // Before the `since` cutoff — must be excluded.
    insertSession(db, { id: idOld, cwd: CWD, startedAt: 1747000000, endedAt: 1747000100 })
    // Different cwd entirely — must never appear.
    insertSession(db, { id: idOther, cwd: "/some/other/proj", startedAt: 1748002000 })
    db.close()

    const sinceIso = new Date(1747900000 * 1000).toISOString()
    const store = CONVERSATION_STORES["hermes"]!
    const found = await store.discover({ cwd: CWD, since: sinceIso })

    expect(found.map(c => c.conversationId).sort()).toEqual([idA, idB].sort())

    const candA = found.find(c => c.conversationId === idA)
    expect(candA).toMatchObject({
      conversationId: idA,
      messageCount: 4,
      preview: "First conversation",
      lastWriter: "acp",
      startedAt: new Date(1748000000 * 1000).toISOString(),
      lastActivityAt: new Date(1748000500 * 1000).toISOString(),
    })

    const candB = found.find(c => c.conversationId === idB)
    expect(candB).toMatchObject({
      conversationId: idB,
      messageCount: 2,
      preview: "Second conversation",
      lastWriter: "cli",
      startedAt: new Date(1748001000 * 1000).toISOString(),
      // no ended_at recorded → falls back to started_at
      lastActivityAt: new Date(1748001000 * 1000).toISOString(),
    })
  })

  it("without expectedId, excludes candidates entirely before `since`", async () => {
    setupFakeHome()
    const db = makeDb()
    insertSession(db, { id: "sess-old", cwd: CWD, startedAt: 1747000000, endedAt: 1747000100 })
    db.close()

    const store = CONVERSATION_STORES["hermes"]!
    const found = await store.discover({
      cwd: CWD,
      since: new Date(1748500000 * 1000).toISOString(),
    })
    expect(found).toEqual([])
  })

  it("returns [] for a cwd with no matching rows", async () => {
    setupFakeHome()
    const db = makeDb()
    insertSession(db, { id: "sess-elsewhere", cwd: "/other/proj", startedAt: 1748000000 })
    db.close()

    const store = CONVERSATION_STORES["hermes"]!
    const found = await store.discover({ cwd: CWD })
    expect(found).toEqual([])
  })
})

// ── read (sqlite) ────────────────────────────────────────────────────

describe.skipIf(!sqliteAvailable)("hermes read", () => {
  let fakeHome: string
  let originalHome: string | undefined

  afterEach(() => {
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  function setupFakeHome(): void {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "conversation-store-hermes-read-"))
    process.env.HOME = fakeHome
    mkdirSync(join(fakeHome, ".hermes"), { recursive: true })
  }

  it("delegates to the shared exportHermesSession sqlite reader", async () => {
    setupFakeHome()
    const DatabaseSync = DatabaseSyncCtor!
    const db = new DatabaseSync(join(fakeHome, ".hermes", "state.db"))
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, cwd TEXT,
        started_at REAL, ended_at REAL, message_count INTEGER, source TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp INTEGER
      );
    `)
    db.prepare(
      `INSERT INTO sessions (id, title, cwd, started_at, message_count, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("sess-read-1", "Read test", "/proj", 1748000000, 1, "acp")
    db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
    ).run("sess-read-1", "user", "hello hermes", 1748000001)
    db.close()

    const store = CONVERSATION_STORES["hermes"]!
    const session = await store.read("sess-read-1")
    expect(session.meta.title).toBe("Read test")
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({ role: "user", text: "hello hermes" })
  })

  it("surfaces the exporter's own error for a missing session id", async () => {
    setupFakeHome()
    const DatabaseSync = DatabaseSyncCtor!
    const db = new DatabaseSync(join(fakeHome, ".hermes", "state.db"))
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id INTEGER PRIMARY KEY);
    `)
    db.close()

    const store = CONVERSATION_STORES["hermes"]!
    await expect(store.read("does-not-exist")).rejects.toThrow(/not found/)
  })
})
