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

  it("carries `async` through like any other pin — absent unless explicitly requested", () => {
    expect(normalizeWorktreeField({ async: true })).toEqual({ async: true })
    expect(normalizeWorktreeField({ slug: "x", async: false })).toEqual({
      slug: "x",
      async: false,
    })
    // `true` (the boolean shorthand) carries no async opt-in — matches
    // `agent_start`'s documented default (synchronous unless asked).
    expect(normalizeWorktreeField(true)).toEqual({})
    expect(Object.keys(normalizeWorktreeField({}) ?? {})).toEqual([])
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

    it("on-request + explicit request → provision, carrying the pins, never implicit", () => {
      expect(
        decideWorktreeIsolation({ mode: "on-request", field: true, depth: 0 }),
      ).toEqual({ action: "provision", request: {}, implicit: false })
      expect(
        decideWorktreeIsolation({
          mode: "on-request",
          field: { slug: "a", base: "origin/b" },
          depth: 0,
        }),
      ).toEqual({ action: "provision", request: { slug: "a", base: "origin/b" }, implicit: false })
    })

    it("on-request + no request → spawn-in-place (back-compat)", () => {
      expect(
        decideWorktreeIsolation({ mode: "on-request", field: undefined, depth: 0 }),
      ).toEqual({ action: "spawn-in-place" })
    })

    it("always → provision whether or not a request is present; implicit only when the caller made none", () => {
      expect(
        decideWorktreeIsolation({ mode: "always", field: undefined, depth: 0 }),
      ).toEqual({ action: "provision", request: {}, implicit: true })
      // An explicit `false` cannot opt out of `always` — still implicit,
      // since the caller made no request either way.
      expect(
        decideWorktreeIsolation({ mode: "always", field: false, depth: 0 }),
      ).toEqual({ action: "provision", request: {}, implicit: true })
      // An explicit request still contributes its pins, and is never implicit.
      expect(
        decideWorktreeIsolation({ mode: "always", field: { slug: "z" }, depth: 0 }),
      ).toEqual({ action: "provision", request: { slug: "z" }, implicit: false })
    })
  })

  // ── nested (a spawn made through the orchestrator sub-gateway) ─────────
  // A nested spawn inherits the parent's ground — never a second worktree.
  // But that is enforced LOUDLY, not silently: an EXPLICIT `worktree` request
  // at depth > 0 asked for isolation it can't get, so it rejects rather than
  // quietly spawning in the shared checkout. Only the absent/`false` case
  // (no request) stays a silent in-place spawn.
  describe("nested (depth > 0) — inherits the parent's ground", () => {
    for (const mode of MODES) {
      it(`${mode} + field=undefined → spawn-in-place (no request, unchanged)`, () => {
        expect(decideWorktreeIsolation({ mode, field: undefined, depth: 1 })).toEqual({
          action: "spawn-in-place",
        })
      })

      it(`${mode} + field=false → spawn-in-place (no request)`, () => {
        expect(decideWorktreeIsolation({ mode, field: false, depth: 1 })).toEqual({
          action: "spawn-in-place",
        })
      })

      for (const field of [true, { slug: "child" }] as WorktreeField[]) {
        it(`${mode} + field=${JSON.stringify(field)} → reject (loud, not silent)`, () => {
          const d = decideWorktreeIsolation({ mode, field, depth: 1 })
          expect(d.action).toBe("reject")
          if (d.action !== "reject") throw new Error("expected reject")
          expect(d.message).toContain("nested")
          expect(d.message).toContain("sandbox")
        })
      }
    }

    it("rejects at any depth > 0, not just depth 1", () => {
      expect(decideWorktreeIsolation({ mode: "on-request", field: true, depth: 3 }).action).toBe(
        "reject",
      )
    })
  })

  // ── nested implicit-in-place into a SHARED, DIRTY cwd ─────────────────
  // The remaining footgun #622 didn't close: an implicit (no `worktree`)
  // nested spawn silently runs in place in whatever cwd it inherited — which
  // may be a live, dirty, shared checkout. Not hard-rejected (in-place is
  // legitimate), but LOUD: the caller passes the impure `sharedDirtyCwd`
  // signal and gets a `spawn-in-place` carrying a `warn`, unless it opts in
  // via `allowSharedCwd`.
  describe("nested (depth > 0) — shared-dirty-cwd warning", () => {
    for (const mode of MODES) {
      it(`${mode} + no request + sharedDirtyCwd → spawn-in-place WITH warn`, () => {
        const d = decideWorktreeIsolation({
          mode,
          field: undefined,
          depth: 1,
          sharedDirtyCwd: true,
        })
        expect(d.action).toBe("spawn-in-place")
        if (d.action !== "spawn-in-place") throw new Error("expected spawn-in-place")
        expect(d.warn).toBeDefined()
        expect(d.warn).toContain("UNCOMMITTED")
        expect(d.warn).toContain("allowSharedCwd")
      })

      it(`${mode} + no request + sharedDirtyCwd=false → plain spawn-in-place (no warn)`, () => {
        expect(
          decideWorktreeIsolation({
            mode,
            field: undefined,
            depth: 1,
            sharedDirtyCwd: false,
          }),
        ).toEqual({ action: "spawn-in-place" })
      })

      it(`${mode} + sharedDirtyCwd + allowSharedCwd → plain spawn-in-place (ack silences warn)`, () => {
        expect(
          decideWorktreeIsolation({
            mode,
            field: undefined,
            depth: 1,
            sharedDirtyCwd: true,
            allowSharedCwd: true,
          }),
        ).toEqual({ action: "spawn-in-place" })
      })
    }

    it("an EXPLICIT request still rejects even when sharedDirtyCwd is set (#622 unchanged)", () => {
      const d = decideWorktreeIsolation({
        mode: "on-request",
        field: true,
        depth: 1,
        sharedDirtyCwd: true,
      })
      expect(d.action).toBe("reject")
    })

    it("the signal is ignored at depth 0 (root spawn unchanged)", () => {
      expect(
        decideWorktreeIsolation({
          mode: "on-request",
          field: undefined,
          depth: 0,
          sharedDirtyCwd: true,
        }),
      ).toEqual({ action: "spawn-in-place" })
    })
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
