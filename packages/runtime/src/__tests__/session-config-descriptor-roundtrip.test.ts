/**
 * Persistence round-trip for the decomposed per-session config axes on
 * `SessionDescriptor` (SPEC §3.7/§3.8, `agentproto-session-config-axes` build
 * step 3). Asserts the "returns properly" invariant: a descriptor with EVERY
 * axis set (effort, posture, route, contextProfile, accessProfile) survives
 * persist→reload unchanged — the canonical form is the decomposed fields, so
 * each one must come back verbatim through the history snapshot, never via a
 * re-parsed compound `mode` string.
 *
 * Same shape as `session-archive.test.ts`'s round-trip case: spawn → flush
 * (shutdown forces the debounced persist) → fresh registry reads the same
 * `sessions.json`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

const fakeAgent: AgentSessionLike = {
  sessionId: "acp-config-roundtrip",
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {}) // never resolves — keeps the session "running"
  },
  async cancel() {},
  async close() {},
}

describe("SessionDescriptor config-axis persistence round-trip", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-config-roundtrip-"))
    persistPath = join(tmp, "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("round-trips every axis (effort/posture/route/contextProfile/accessProfile) unchanged through a reload", () => {
    const reg1 = createSessionsRegistry({ persistPath })
    const desc = reg1.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      // Orthogonal axes that have NO single legacy `mode` id between them
      // (plan + moonshot) — the exact combination §3.8 says must round-trip
      // through the decomposed descriptor fields, not a recomposed string.
      effort: "ultracode",
      posture: "plan",
      route: { gateway: "moonshot", baseUrl: "https://api.moonshot.ai/anthropic" },
      contextProfile: "lean",
      accessProfile: {
        profileRef: "work-moonshot",
        label: "Work Moonshot",
        endpoint: "moonshot",
        method: "api-key",
      },
    })

    // Sanity: the live descriptor already carries them.
    expect(desc.effort).toBe("ultracode")
    expect(desc.posture).toBe("plan")

    reg1.kill(desc.id)
    // Force a synchronous flush — persist is debounced.
    reg1.shutdown()

    const reg2 = createSessionsRegistry({ persistPath })
    const reloaded = reg2.get(desc.id)
    expect(reloaded).toBeDefined()
    expect(reloaded?.effort).toBe("ultracode")
    expect(reloaded?.posture).toBe("plan")
    expect(reloaded?.route).toEqual({
      gateway: "moonshot",
      baseUrl: "https://api.moonshot.ai/anthropic",
    })
    expect(reloaded?.contextProfile).toBe("lean")
    expect(reloaded?.accessProfile).toEqual({
      profileRef: "work-moonshot",
      label: "Work Moonshot",
      endpoint: "moonshot",
      method: "api-key",
    })
    reg2.shutdown()
  })

  it("round-trips the structured `{ harnessModeId }` posture form through JSON", () => {
    const reg1 = createSessionsRegistry({ persistPath })
    const desc = reg1.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      // The non-canonical posture arm — a raw harness mode id, an OBJECT that
      // has to survive JSON serialization intact (not collapse to a string).
      posture: { harnessModeId: "some-native-mode" },
    })
    reg1.kill(desc.id)
    reg1.shutdown()

    const reg2 = createSessionsRegistry({ persistPath })
    expect(reg2.get(desc.id)?.posture).toEqual({ harnessModeId: "some-native-mode" })
    reg2.shutdown()
  })

  it("leaves the axis fields absent when none are supplied (adapter-default = undefined)", () => {
    const reg1 = createSessionsRegistry({ persistPath })
    const desc = reg1.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    reg1.kill(desc.id)
    reg1.shutdown()

    const reg2 = createSessionsRegistry({ persistPath })
    const reloaded = reg2.get(desc.id)
    expect(reloaded).toBeDefined()
    expect(reloaded?.effort).toBeUndefined()
    expect(reloaded?.posture).toBeUndefined()
    expect(reloaded?.route).toBeUndefined()
    expect(reloaded?.contextProfile).toBeUndefined()
    expect(reloaded?.accessProfile).toBeUndefined()
    reg2.shutdown()
  })
})
