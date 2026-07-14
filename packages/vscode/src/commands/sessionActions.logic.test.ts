import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import {
  describeSession,
  isLiveSession,
  mapSessionsToQuickPickItems,
  normalizeSessionArg,
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
  it("prefers label, then name, then id", () => {
    expect(describeSession(session({ label: "my-label", name: "my-name" }))).toBe("my-label")
    expect(describeSession(session({ name: "my-name" }))).toBe("my-name")
    expect(describeSession(session({ id: "bare-id" }))).toBe("bare-id")
  })
})

describe("mapSessionsToQuickPickItems", () => {
  it("maps label/description/session for each entry", () => {
    const s = session({ label: "sales-analysis", adapterSlug: "claude-code", status: "running" })
    const items = mapSessionsToQuickPickItems([s])
    expect(items).toEqual([{ label: "sales-analysis", description: "claude-code · running", session: s }])
  })

  it("falls back to kind when adapterSlug is absent", () => {
    const s = session({ kind: "terminal", adapterSlug: undefined, status: "running" })
    const items = mapSessionsToQuickPickItems([s])
    expect(items[0]!.description).toBe("terminal · running")
  })
})
