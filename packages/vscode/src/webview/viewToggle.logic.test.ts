import { describe, expect, it } from "vitest"

import { canToggleView } from "./viewToggle.logic.js"
import type { SessionDescriptor } from "../client/types.js"

type Sess = Pick<SessionDescriptor, "kind" | "pty" | "adapterSlug" | "argv">

function sess(over: Partial<Sess> = {}): Sess {
  return { kind: "agent-cli", ...over }
}

describe("canToggleView", () => {
  it("is true for an agent-cli session (structured events + raw stream)", () => {
    expect(canToggleView(sess({ kind: "agent-cli" }))).toBe(true)
  })

  it("is true for a native-conversation PTY (claude terminal: transcript + raw)", () => {
    // A claude PTY maps to a known conversation store — via adapterSlug…
    expect(canToggleView(sess({ kind: "terminal", pty: true, adapterSlug: "claude-code" }))).toBe(true)
    // …or, absent a slug, via the argv binary basename (claude → claude-code).
    expect(canToggleView(sess({ kind: "terminal", pty: true, argv: ["claude"] }))).toBe(true)
  })

  it("is false for a plain non-native PTY (no conversation store to bridge)", () => {
    expect(canToggleView(sess({ kind: "terminal", pty: true, argv: ["bash"] }))).toBe(false)
  })

  it("is false for a non-PTY terminal", () => {
    expect(canToggleView(sess({ kind: "terminal", pty: false, argv: ["bash"] }))).toBe(false)
  })

  it("is false for command and browser sessions", () => {
    expect(canToggleView(sess({ kind: "command" }))).toBe(false)
    expect(canToggleView(sess({ kind: "browser" }))).toBe(false)
  })
})
