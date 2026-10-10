/**
 * The cold-history fallback (`session-cold-list.ts`): the on-disk sidecar
 * mapped back into a descriptor, so the listers can serve sessions the
 * registry dropped at boot (`HISTORY_CAP`). Hermetic — every read is
 * pointed at a temp dir, never the real `~/.agentproto`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  COLD_TTL_MS,
  coldSessionDescriptor,
  coldSessionRows,
  resetColdSessionCache,
  sessionDescriptorFromIndexEntry,
} from "../session-cold-list.js"
import type { SessionIndexEntry } from "../session-index.js"

let baseDir: string

const writeSidecar = (id: string, entry: Partial<SessionIndexEntry>): void => {
  const dir = join(baseDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "index.json"), JSON.stringify({ id, ...entry }))
}

const writeEvents = (id: string, lines: object[]): void => {
  const dir = join(baseDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "events.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n")
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "session-cold-"))
  resetColdSessionCache()
})

afterEach(() => {
  resetColdSessionCache()
  rmSync(baseDir, { recursive: true, force: true })
})

const entry = (overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry => ({
  id: "sess_cold1",
  kind: "agent-cli",
  status: "exited",
  alive: false,
  startedAt: "2026-05-01T10:00:00.000Z",
  ...overrides,
})

describe("sessionDescriptorFromIndexEntry", () => {
  it("carries the sidecar's identity and flags a cold, terminal row", () => {
    const desc = sessionDescriptorFromIndexEntry(
      entry({
        label: "review: pr-42",
        title: "Review PR 42",
        cwd: "/repo/agentproto",
        workspaceSlug: "agentproto",
        adapter: "claude-code",
        origin: "review",
        depth: 2,
        parentSessionId: "sess_parent",
        lastActivityAt: "2026-05-01T11:00:00.000Z",
      }),
    )
    expect(desc).toMatchObject({
      id: "sess_cold1",
      kind: "agent-cli",
      status: "exited",
      alive: false,
      cold: true,
      pid: null,
      label: "review: pr-42",
      title: "Review PR 42",
      cwd: "/repo/agentproto",
      workspaceSlug: "agentproto",
      adapterSlug: "claude-code",
      origin: "review",
      depth: 2,
      parentSessionId: "sess_parent",
      lastActivityAt: "2026-05-01T11:00:00.000Z",
    })
  })

  it("reclassifies a stale live status to killed — the registry holds no process", () => {
    for (const stale of ["running", "starting"] as const) {
      const desc = sessionDescriptorFromIndexEntry(entry({ status: stale, alive: true }))
      expect(desc.status).toBe("killed")
      expect(desc.alive).toBe(false)
    }
  })

  it("keeps every genuinely terminal status", () => {
    for (const status of ["exited", "killed", "error"] as const) {
      expect(sessionDescriptorFromIndexEntry(entry({ status })).status).toBe(status)
    }
  })

  it("falls back to safe defaults for an unknown kind and a missing slug", () => {
    const desc = sessionDescriptorFromIndexEntry(entry({ kind: "wat" }))
    expect(desc.kind).toBe("agent-cli")
    expect(desc.workspaceSlug).toBe("default")
  })

  it("preserves `archived` so the listers can still hide archived history", () => {
    expect(sessionDescriptorFromIndexEntry(entry({ archived: true })).archived).toBe(true)
    expect(sessionDescriptorFromIndexEntry(entry()).archived).toBeUndefined()
  })
})

describe("coldSessionRows — the TTL-cached scan", () => {
  it("reads every sidecar under the base dir, newest activity first", () => {
    writeSidecar("sess_old", entry({ id: "sess_old", lastActivityAt: "2026-05-01T09:00:00.000Z" }))
    writeSidecar("sess_new", entry({ id: "sess_new", lastActivityAt: "2026-05-02T09:00:00.000Z" }))
    expect(coldSessionRows(baseDir).map(s => s.id)).toEqual(["sess_new", "sess_old"])
  })

  it("recovers a session with no sidecar from its transcript tail", () => {
    writeEvents("sess_derived", [
      { seq: 1, ts: "2026-05-03T10:00:00.000Z", kind: "user-prompt", text: "hello" },
    ])
    const rows = coldSessionRows(baseDir)
    expect(rows.map(s => s.id)).toEqual(["sess_derived"])
    expect(rows[0]!.cold).toBe(true)
  })

  it("returns [] for a base dir that does not exist", () => {
    expect(coldSessionRows(join(baseDir, "nope"))).toEqual([])
  })

  it("serves the cached scan inside the TTL window and re-reads after a reset", () => {
    writeSidecar("sess_a", entry({ id: "sess_a", lastActivityAt: "2026-05-01T09:00:00.000Z" }))
    expect(coldSessionRows(baseDir, 1_000).map(s => s.id)).toEqual(["sess_a"])

    // Inside the window: the new sidecar is invisible (still cached) …
    writeSidecar("sess_b", entry({ id: "sess_b", lastActivityAt: "2026-05-02T09:00:00.000Z" }))
    expect(coldSessionRows(baseDir, 1_000 + COLD_TTL_MS - 1).map(s => s.id)).toEqual(["sess_a"])

    // … and a fresh scan picks it up.
    expect(coldSessionRows(baseDir, 1_000 + COLD_TTL_MS).map(s => s.id)).toEqual(["sess_b", "sess_a"])

    // A different base dir never reuses another dir's cache.
    const other = mkdtempSync(join(tmpdir(), "session-cold-other-"))
    try {
      mkdirSync(join(other, "sess_c"), { recursive: true })
      writeFileSync(
        join(other, "sess_c", "index.json"),
        JSON.stringify({ ...entry(), id: "sess_c" }),
      )
      expect(coldSessionRows(baseDir, 1_000 + COLD_TTL_MS).map(s => s.id)).toEqual(["sess_b", "sess_a"])
      expect(coldSessionRows(other, 1_000 + COLD_TTL_MS).map(s => s.id)).toEqual(["sess_c"])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe("coldSessionDescriptor — the single-id rescue", () => {
  it("reads one sidecar by id", () => {
    writeSidecar("sess_one", entry({ id: "sess_one", label: "the one" }))
    expect(coldSessionDescriptor("sess_one", baseDir)?.label).toBe("the one")
  })

  it("derives from the transcript when the sidecar is missing", () => {
    writeEvents("sess_tail", [
      { seq: 1, ts: "2026-05-03T10:00:00.000Z", kind: "user-prompt", text: "prompt" },
      { seq: 2, ts: "2026-05-03T10:00:01.000Z", kind: "text-delta", text: "reply" },
    ])
    const desc = coldSessionDescriptor("sess_tail", baseDir)
    expect(desc?.id).toBe("sess_tail")
    expect(desc?.kind).toBe("agent-cli")
    expect(desc?.cold).toBe(true)
  })

  it("returns undefined for an id nothing on disk knows", () => {
    expect(coldSessionDescriptor("sess_ghost", baseDir)).toBeUndefined()
  })

  it("rejects path-like ids before they reach the filesystem", () => {
    // A caller-supplied id becomes half of `join(baseDir, id, …)`; a
    // traversal must not read an index.json outside the store.
    for (const evil of ["../outside", "a/b", "..", ".", "a\\b", "", "a".repeat(201)]) {
      expect(coldSessionDescriptor(evil, baseDir)).toBeUndefined()
    }
  })
})
