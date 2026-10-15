import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  resolveSessionRef,
  sessionRefSchema,
  mintSlug,
  type SessionRef,
} from "../session-ref.js"
import type { SessionsRegistry } from "../sessions.js"
import { createSessionsRegistry } from "../sessions.js"

type Row = { id: string; name?: string; slug?: string }

function fakeRegistry(rows: Row[]): Pick<SessionsRegistry, "get" | "list"> {
  const byId = new Map(rows.map(row => [row.id, row]))
  return {
    get: (id: string) => byId.get(id),
    list: () => rows,
  } as unknown as Pick<SessionsRegistry, "get" | "list">
}

describe("resolveSessionRef", () => {
  it("resolves an exact id hit", () => {
    const registry = fakeRegistry([{ id: "sess_aaaa1111" }, { id: "sess_bbbb2222" }])
    expect(resolveSessionRef(registry, { sessionId: "sess_aaaa1111" })).toEqual({
      ok: true,
      id: "sess_aaaa1111",
    })
  })

  it("resolves an exact slug hit", () => {
    const registry = fakeRegistry([
      { id: "sess_aaaa1111", slug: "night-shift" },
      { id: "sess_bbbb2222", slug: "morning-shift" },
    ])
    expect(resolveSessionRef(registry, { slug: "morning-shift" })).toEqual({
      ok: true,
      id: "sess_bbbb2222",
    })
  })

  it("resolves a legacy name hit via idOrName", () => {
    const registry = fakeRegistry([
      { id: "sess_aaaa1111", name: "claude-main" },
      { id: "sess_bbbb2222", name: "claude-side" },
    ])
    expect(resolveSessionRef(registry, { idOrName: "claude-side" })).toEqual({
      ok: true,
      id: "sess_bbbb2222",
    })
  })

  it("prefers an exact id over a name", () => {
    const registry = fakeRegistry([{ id: "shared", name: "shared" }, { id: "sess_zzzz", name: "shared" }])
    expect(resolveSessionRef(registry, { idOrName: "shared" })).toEqual({
      ok: true,
      id: "shared",
    })
  })

  it("returns required when none of the three keys is supplied", () => {
    const registry = fakeRegistry([{ id: "sess_aaaa1111" }])
    expect(resolveSessionRef(registry, {})).toEqual({
      ok: false,
      error: { code: "required" },
    })
  })

  it("returns not_found with the query when nothing matches", () => {
    const registry = fakeRegistry([{ id: "sess_aaaa1111", name: "claude-main" }])
    expect(resolveSessionRef(registry, { idOrName: "nope" })).toEqual({
      ok: false,
      error: { code: "not_found", query: "nope" },
    })
  })

  it("returns ambiguous with sorted ids when two sessions share a name", () => {
    const registry = fakeRegistry([
      { id: "sess_zzzz9999", name: "dupe" },
      { id: "sess_aaaa0000", name: "dupe" },
    ])
    expect(resolveSessionRef(registry, { idOrName: "dupe" })).toEqual({
      ok: false,
      error: { code: "ambiguous", query: "dupe", ids: ["sess_aaaa0000", "sess_zzzz9999"] },
    })
  })

  it("trims the query before resolving", () => {
    const registry = fakeRegistry([{ id: "sess_aaaa1111", name: "claude-main" }])
    expect(resolveSessionRef(registry, { idOrName: "  claude-main  " })).toEqual({
      ok: true,
      id: "sess_aaaa1111",
    })
  })

  it("accepts an agreeing multi-key ref and reports a conflict for a disagreeing one", () => {
    const registry = fakeRegistry([
      { id: "sess_aaaa1111", name: "claude-main", slug: "main" },
      { id: "sess_bbbb2222", name: "claude-side", slug: "side" },
    ])
    const agreeing: SessionRef = { sessionId: "sess_aaaa1111", idOrName: "claude-main", slug: "main" }
    expect(resolveSessionRef(registry, agreeing)).toEqual({ ok: true, id: "sess_aaaa1111" })

    // Two keys, both resolve, but to different sessions → conflict listing both keys.
    const disagreeing: SessionRef = { sessionId: "sess_aaaa1111", idOrName: "claude-side" }
    expect(resolveSessionRef(registry, disagreeing)).toEqual({
      ok: false,
      error: { code: "conflict", query: "sess_aaaa1111", keys: ["sessionId", "idOrName"] },
    })

    // One resolves, the other does not → still a conflict, not a not_found.
    const halfMissing: SessionRef = { sessionId: "sess_aaaa1111", slug: "nope" }
    expect(resolveSessionRef(registry, halfMissing)).toEqual({
      ok: false,
      error: { code: "conflict", query: "sess_aaaa1111", keys: ["sessionId", "slug"] },
    })
  })

  it("keeps single-key not_found/ambiguous unchanged", () => {
    const registry = fakeRegistry([{ id: "sess_aaaa1111", name: "claude-main" }])
    expect(resolveSessionRef(registry, { slug: "nope" })).toEqual({
      ok: false,
      error: { code: "not_found", query: "nope" },
    })
  })
})

describe("sessionRefSchema", () => {
  it("spreads into a schema accepting all three optional keys", () => {
    const schema = z.object(sessionRefSchema(z))
    expect(schema.parse({})).toEqual({})
    expect(schema.parse({ sessionId: "sess_x", idOrName: "y", slug: "z" })).toEqual({
      sessionId: "sess_x",
      idOrName: "y",
      slug: "z",
    })
  })
})

describe("findByIdOrName (delegates to resolveSessionRef)", () => {
  function twoSessions() {
    const registry = createSessionsRegistry({ persist: false })
    const spawn = () =>
      registry.spawn({
        kind: "command",
        workspaceSlug: "default",
        cwd: "/tmp",
        argv: [process.execPath, "-e", "0"],
      })
    return { registry, a: spawn(), b: spawn() }
  }

  it("resolves by exact id, by name, and returns undefined for an unknown query", () => {
    const { registry, a, b } = twoSessions()
    a.name = "solo"
    b.name = "other"
    expect(registry.findByIdOrName(a.id)?.id).toBe(a.id)
    expect(registry.findByIdOrName("solo")?.id).toBe(a.id)
    expect(registry.findByIdOrName("nope")).toBeUndefined()
  })

  it("returns undefined for a duplicate name (ambiguous), never a first-match", () => {
    const { registry, a, b } = twoSessions()
    a.name = "dupe"
    b.name = "dupe"
    expect(registry.findByIdOrName("dupe")).toBeUndefined()
  })
})

describe("mintSlug", () => {
  it("slugifies the desired string", () => {
    expect(mintSlug("Night Shift!", () => false, "sess_aaaa1111")).toBe("night-shift")
  })

  it("appends -2, -3 … while the candidate is taken", () => {
    const taken = new Set(["night-shift", "night-shift-2"])
    expect(mintSlug("night shift", s => taken.has(s), "sess_aaaa1111")).toBe("night-shift-3")
  })

  it("falls back to sess-<shortid> when the desired slugifies to empty", () => {
    expect(mintSlug("!!!", () => false, "sess_aaaa1111")).toBe("sess-aa1111")
  })
})
