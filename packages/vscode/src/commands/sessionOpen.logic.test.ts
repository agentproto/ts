import { describe, expect, it } from "vitest"

import { defaultOpenTarget } from "./sessionOpen.logic.js"
import type { SessionDescriptor } from "../client/types.js"

type Sess = Pick<SessionDescriptor, "kind" | "pty" | "adapterSlug" | "argv">

function sess(over: Partial<Sess> = {}): Sess {
  return { kind: "agent-cli", ...over }
}

describe("defaultOpenTarget", () => {
  it("routes a browser session to the browser view", () => {
    expect(defaultOpenTarget(sess({ kind: "browser" }))).toBe("browser")
  })

  it("routes a plain terminal PTY to the real terminal", () => {
    expect(defaultOpenTarget(sess({ kind: "terminal", pty: true, argv: ["bash"] }))).toBe("terminal")
  })

  it("routes a non-PTY terminal-kind session to the real terminal", () => {
    expect(defaultOpenTarget(sess({ kind: "terminal", pty: false, argv: ["bash"] }))).toBe("terminal")
  })

  it("keeps a native-conversation PTY (claude/hermes terminal) on the transcript panel", () => {
    expect(defaultOpenTarget(sess({ kind: "terminal", pty: true, adapterSlug: "claude-code" }))).toBe("transcript")
    expect(defaultOpenTarget(sess({ kind: "terminal", pty: true, argv: ["claude"] }))).toBe("transcript")
  })

  it("routes agent-cli sessions to the transcript panel", () => {
    expect(defaultOpenTarget(sess({ kind: "agent-cli" }))).toBe("transcript")
  })

  it("routes command sessions to the transcript panel", () => {
    expect(defaultOpenTarget(sess({ kind: "command" }))).toBe("transcript")
  })
})
