/**
 * The policy layer for `agent_start.worktree` — the pure decision matrix
 * (`decideWorktreeIsolation`) and the env/config resolver
 * (`loadWorktreeIsolation`). No git, no filesystem: the resolution matrix is
 * a pure function, and the resolver takes an injected config loader so it
 * never reads the real `~/.agentproto/config.json`. The side-effecting half
 * (actual provisioning through the injected port) is covered against
 * `spawnAgentSession` in session-spawn.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  decideWorktreeIsolation,
  loadWorktreeIsolation,
  normalizeWorktreeField,
  parseWorktreeIsolationMode,
  WORKTREE_ISOLATION_ENV,
  type WorktreeField,
  type WorktreeIsolationMode,
} from "../worktree-isolation.js"

describe("normalizeWorktreeField", () => {
  it("treats absent / false as no request", () => {
    expect(normalizeWorktreeField(undefined)).toBeUndefined()
    expect(normalizeWorktreeField(false)).toBeUndefined()
  })

  it("treats true and an object as a request", () => {
    expect(normalizeWorktreeField(true)).toEqual({})
    expect(normalizeWorktreeField({})).toEqual({})
    expect(normalizeWorktreeField({ slug: "fix", base: "origin/dev" })).toEqual({
      slug: "fix",
      base: "origin/dev",
    })
  })

  it("keeps only the provided pins (no undefined keys)", () => {
    expect(normalizeWorktreeField({ slug: "x" })).toEqual({ slug: "x" })
    expect(Object.keys(normalizeWorktreeField({ slug: "x" }) ?? {})).toEqual(["slug"])
  })
})

describe("decideWorktreeIsolation — resolution matrix", () => {
  const MODES: WorktreeIsolationMode[] = ["always", "on-request", "never"]

  // ── depth 0 (a root spawn) ────────────────────────────────────────────
  describe("depth 0", () => {
    it("never + explicit request → reject (loud, not silent)", () => {
      const d = decideWorktreeIsolation({ mode: "never", field: true, depth: 0 })
      expect(d.action).toBe("reject")
      if (d.action !== "reject") throw new Error("expected reject")
      expect(d.message).toContain("never")
    })

    it("never + no request → spawn-in-place", () => {
      expect(decideWorktreeIsolation({ mode: "never", field: undefined, depth: 0 })).toEqual({
        action: "spawn-in-place",
      })
      expect(decideWorktreeIsolation({ mode: "never", field: false, depth: 0 })).toEqual({
        action: "spawn-in-place",
      })
    })

    it("on-request + explicit request → provision, carrying the pins", () => {
      expect(
        decideWorktreeIsolation({ mode: "on-request", field: true, depth: 0 }),
      ).toEqual({ action: "provision", request: {} })
      expect(
        decideWorktreeIsolation({
          mode: "on-request",
          field: { slug: "a", base: "origin/b" },
          depth: 0,
        }),
      ).toEqual({ action: "provision", request: { slug: "a", base: "origin/b" } })
    })

    it("on-request + no request → spawn-in-place (back-compat)", () => {
      expect(
        decideWorktreeIsolation({ mode: "on-request", field: undefined, depth: 0 }),
      ).toEqual({ action: "spawn-in-place" })
    })

    it("always → provision whether or not a request is present", () => {
      expect(
        decideWorktreeIsolation({ mode: "always", field: undefined, depth: 0 }),
      ).toEqual({ action: "provision", request: {} })
      // An explicit `false` cannot opt out of `always`.
      expect(
        decideWorktreeIsolation({ mode: "always", field: false, depth: 0 }),
      ).toEqual({ action: "provision", request: {} })
      // An explicit request still contributes its pins.
      expect(
        decideWorktreeIsolation({ mode: "always", field: { slug: "z" }, depth: 0 }),
      ).toEqual({ action: "provision", request: { slug: "z" } })
    })
  })

  // ── nested (a spawn made through the orchestrator sub-gateway) ─────────
  describe("nested (depth > 0) — always spawn-in-place, inheriting the parent's ground", () => {
    for (const mode of MODES) {
      for (const field of [undefined, true, { slug: "child" }] as WorktreeField[]) {
        it(`${mode} + field=${JSON.stringify(field)} → spawn-in-place`, () => {
          expect(decideWorktreeIsolation({ mode, field, depth: 1 })).toEqual({
            action: "spawn-in-place",
          })
        })
      }
    }
  })
})

describe("parseWorktreeIsolationMode", () => {
  it("accepts the three modes and rejects everything else", () => {
    expect(parseWorktreeIsolationMode("always")).toBe("always")
    expect(parseWorktreeIsolationMode("on-request")).toBe("on-request")
    expect(parseWorktreeIsolationMode("never")).toBe("never")
    expect(parseWorktreeIsolationMode("sometimes")).toBeUndefined()
    expect(parseWorktreeIsolationMode(undefined)).toBeUndefined()
    expect(parseWorktreeIsolationMode("")).toBeUndefined()
  })
})

describe("loadWorktreeIsolation — env > config > default", () => {
  const saved = process.env[WORKTREE_ISOLATION_ENV]
  beforeEach(() => {
    delete process.env[WORKTREE_ISOLATION_ENV]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[WORKTREE_ISOLATION_ENV]
    else process.env[WORKTREE_ISOLATION_ENV] = saved
  })

  it("defaults to on-request when nothing is set", async () => {
    expect(await loadWorktreeIsolation(async () => ({}))).toBe("on-request")
  })

  it("reads the config field when env is unset", async () => {
    expect(
      await loadWorktreeIsolation(async () => ({ worktrees: { isolation: "always" } })),
    ).toBe("always")
  })

  it("env wins over the config field", async () => {
    process.env[WORKTREE_ISOLATION_ENV] = "never"
    expect(
      await loadWorktreeIsolation(async () => ({ worktrees: { isolation: "always" } })),
    ).toBe("never")
  })

  it("ignores a garbage env value and falls through to config", async () => {
    process.env[WORKTREE_ISOLATION_ENV] = "bogus"
    expect(
      await loadWorktreeIsolation(async () => ({ worktrees: { isolation: "always" } })),
    ).toBe("always")
  })

  it("falls back to the default when the config loader throws", async () => {
    expect(
      await loadWorktreeIsolation(async () => {
        throw new Error("unreadable")
      }),
    ).toBe("on-request")
  })
})
