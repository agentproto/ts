import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import {
  describeSession,
  findSessionByRef,
  isLiveSession,
  mapSessionsToQuickPickItems,
  normalizeSessionArg,
  sessionMatchesRef,
} from "./sessionActions.logic.js"

function session(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: 123,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("normalizeSessionArg", () => {
  it("returns undefined for undefined (command-palette invocation)", () => {
    expect(normalizeSessionArg(undefined)).toBeUndefined()
  })

  it("returns a raw SessionDescriptor unchanged", () => {
    const s = session()
    expect(normalizeSessionArg(s)).toBe(s)
  })

  it("unwraps a tree-item arg shaped { session }", () => {
    const s = session({ id: "s2" })
    expect(normalizeSessionArg({ session: s })).toBe(s)
  })

  it("returns undefined for an unrelated object", () => {
    expect(normalizeSessionArg({ foo: "bar" })).toBeUndefined()
  })

  it("returns undefined for a string arg", () => {
    expect(normalizeSessionArg("s1")).toBeUndefined()
  })

  it("returns undefined for null", () => {
    expect(normalizeSessionArg(null)).toBeUndefined()
  })

  it("returns undefined when the wrapped session is malformed", () => {
    expect(normalizeSessionArg({ session: { id: "s1" } })).toBeUndefined()
  })
})

describe("isLiveSession", () => {
  it("treats running and starting as live", () => {
    expect(isLiveSession(session({ status: "running" }))).toBe(true)
    expect(isLiveSession(session({ status: "starting" }))).toBe(true)
  })

  it("treats exited/killed/error as not live", () => {
    expect(isLiveSession(session({ status: "exited" }))).toBe(false)
    expect(isLiveSession(session({ status: "killed" }))).toBe(false)
    expect(isLiveSession(session({ status: "error" }))).toBe(false)
  })
})

describe("describeSession", () => {
  it("prefers label, then slug, then legacy name, then id", () => {
    expect(describeSession(session({ label: "my-label", slug: "my-slug", name: "my-name" }))).toBe(
      "my-label",
    )
    expect(describeSession(session({ slug: "my-slug", name: "my-name" }))).toBe("my-slug")
    expect(describeSession(session({ name: "my-name" }))).toBe("my-name")
    expect(describeSession(session({ id: "bare-id" }))).toBe("bare-id")
  })
})

describe("sessionMatchesRef / findSessionByRef", () => {
  it("accepts a slug as a session reference (the unique human handle)", () => {
    const s = session({ id: "sess_abc123", slug: "fix-login-bug" })
    expect(sessionMatchesRef(s, "fix-login-bug")).toBe(true)
    expect(findSessionByRef([s], "fix-login-bug")).toBe(s)
  })

  it("still accepts the id and the legacy name", () => {
    const s = session({ id: "sess_abc123", slug: "fix-login-bug", name: "legacy-name" })
    expect(sessionMatchesRef(s, "sess_abc123")).toBe(true)
    expect(sessionMatchesRef(s, "legacy-name")).toBe(true)
  })

  it("does not match an unrelated reference", () => {
    const s = session({ id: "sess_abc123", slug: "fix-login-bug" })
    expect(sessionMatchesRef(s, "other")).toBe(false)
    expect(findSessionByRef([s], "other")).toBeUndefined()
  })
})

describe("mapSessionsToQuickPickItems", () => {
  it("maps label/description/session for each entry", () => {
    const s = session({ label: "sales-analysis", slug: "sales-analysis", adapterSlug: "claude-code", status: "running" })
    const items = mapSessionsToQuickPickItems([s])
    expect(items).toEqual([
      { label: "sales-analysis", description: "sales-analysis · claude-code · running", session: s },
    ])
  })

  it("omits the slug segment when the session has none", () => {
    const s = session({ label: "sales-analysis", adapterSlug: "claude-code", status: "running" })
    const items = mapSessionsToQuickPickItems([s])
    expect(items[0]!.description).toBe("claude-code · running")
  })

  it("falls back to kind when adapterSlug is absent", () => {
    const s = session({ kind: "terminal", adapterSlug: undefined, status: "running" })
    const items = mapSessionsToQuickPickItems([s])
    expect(items[0]!.description).toBe("terminal · running")
  })
})
