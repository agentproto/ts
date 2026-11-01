/**
 * Pure rules for the one-owner-per-PR/branch lock (`spawn-owner-lock.ts`):
 * key canonicalisation and the live / recently-ended conflict test. The
 * spawn-path wiring is covered in `session-spawn.test.ts`.
 */

import { describe, expect, it } from "vitest"
import {
  findOwnerConflict,
  normalizeOwnerKey,
  OWNER_KEY_META,
  OWNER_LOCK_TTL_MS,
  type OwnerLockSession,
} from "../spawn-owner-lock.js"

describe("normalizeOwnerKey — PR keys", () => {
  it("accepts the canonical form unchanged", () => {
    expect(normalizeOwnerKey("pr:agentik-studio/agentik-studio#1440")).toEqual({
      ok: true,
      key: "pr:agentik-studio/agentik-studio#1440",
    })
  })

  it("normalises case, whitespace, leading zeros and a .git suffix", () => {
    expect(normalizeOwnerKey(" PR:Agentik-Studio/Agentik-Studio#01440 ")).toEqual({
      ok: true,
      key: "pr:agentik-studio/agentik-studio#1440",
    })
    expect(normalizeOwnerKey("pr:agentik-studio/agentik-studio.git#1440")).toEqual({
      ok: true,
      key: "pr:agentik-studio/agentik-studio#1440",
    })
  })

  it("strips a GitHub URL / scp-style prefix", () => {
    expect(
      normalizeOwnerKey("pr:https://github.com/Agentik-Studio/Agentik-Studio#1440"),
    ).toEqual({ ok: true, key: "pr:agentik-studio/agentik-studio#1440" })
    expect(
      normalizeOwnerKey("pr:git@github.com:agentik-studio/agentik-studio.git#1440"),
    ).toEqual({ ok: true, key: "pr:agentik-studio/agentik-studio#1440" })
  })

  it("rejects a malformed PR key", () => {
    expect(normalizeOwnerKey("pr:agentik-studio/agentik-studio").ok).toBe(false)
    expect(normalizeOwnerKey("pr:agentik-studio/agentik-studio#nope").ok).toBe(false)
    expect(normalizeOwnerKey("pr:agentik-studio/agentik-studio#0").ok).toBe(false)
    expect(normalizeOwnerKey("pr:no-slash#1").ok).toBe(false)
  })
})

describe("normalizeOwnerKey — branch keys", () => {
  it("accepts a branch name and strips refs/heads/", () => {
    expect(normalizeOwnerKey("branch:gardefou/L4-owner-lock")).toEqual({
      ok: true,
      key: "branch:gardefou/L4-owner-lock",
    })
    expect(normalizeOwnerKey("branch:refs/heads/gardefou/L4-owner-lock")).toEqual({
      ok: true,
      key: "branch:gardefou/L4-owner-lock",
    })
  })

  it("keeps branch case — git branch names are case-sensitive", () => {
    expect(normalizeOwnerKey("branch:Fix-Case")).toEqual({ ok: true, key: "branch:Fix-Case" })
  })

  it("rejects empty or whitespace-bearing branch names", () => {
    expect(normalizeOwnerKey("branch:").ok).toBe(false)
    expect(normalizeOwnerKey("branch:   ").ok).toBe(false)
    expect(normalizeOwnerKey("branch:has space").ok).toBe(false)
  })

  it("rejects an unknown shape", () => {
    expect(normalizeOwnerKey("issue:agentik-studio/agentik-studio#1440").ok).toBe(false)
    expect(normalizeOwnerKey("1440").ok).toBe(false)
  })
})

describe("findOwnerConflict", () => {
  const key = "pr:agentik-studio/agentik-studio#1440"
  const now = Date.parse("2026-11-01T12:00:00Z")

  function session(overrides: Partial<OwnerLockSession> = {}): OwnerLockSession {
    return { id: "sess_owner", status: "running", ...overrides }
  }

  it("returns a live session holding the key", () => {
    const owner = session({ meta: { [OWNER_KEY_META]: key } })
    expect(findOwnerConflict([owner], key, now)?.id).toBe("sess_owner")
    expect(findOwnerConflict([owner], key, now)?.id).toBe("sess_owner")
  })

  it("treats a starting row as live", () => {
    const owner = session({ status: "starting", meta: { [OWNER_KEY_META]: key } })
    expect(findOwnerConflict([owner], key, now)?.id).toBe("sess_owner")
  })

  it("ignores a different key", () => {
    const other = session({
      meta: { [OWNER_KEY_META]: "pr:agentik-studio/agentik-studio#9999" },
    })
    expect(findOwnerConflict([other], key, now)).toBeUndefined()
  })

  it("returns a session ended less than 24h ago, including a reaped one", () => {
    const reaped = session({
      status: "killed",
      // 23h59m ago — still inside the window.
      endedAt: new Date(now - OWNER_LOCK_TTL_MS + 60_000).toISOString(),
      meta: { [OWNER_KEY_META]: key },
    })
    expect(findOwnerConflict([reaped], key, now)?.id).toBe("sess_owner")
  })

  it("frees the key once the owner has been ended for 24h or more", () => {
    const old = session({
      status: "killed",
      endedAt: new Date(now - OWNER_LOCK_TTL_MS).toISOString(),
      meta: { [OWNER_KEY_META]: key },
    })
    expect(findOwnerConflict([old], key, now)).toBeUndefined()
  })

  it("prefers the explicit alive projection over a stale status", () => {
    const stale = session({
      status: "running",
      alive: false,
      endedAt: new Date(now - OWNER_LOCK_TTL_MS * 2).toISOString(),
      meta: { [OWNER_KEY_META]: key },
    })
    expect(findOwnerConflict([stale], key, now)).toBeUndefined()
  })
})
