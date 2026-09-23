import { describe, expect, it } from "vitest"

import { defaultOpenTarget } from "./sessionOpen.logic.js"
import type { SessionDescriptor } from "../client/types.js"

type Sess = Pick<SessionDescriptor, "kind" | "status" | "pty" | "adapterSlug" | "argv">

function sess(over: Partial<Sess> = {}): Sess {
  return { kind: "agent-cli", status: "running", ...over }
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

  it("routes a native-conversation PTY (claude/hermes terminal) to the TERMINAL — the operator asked for one; the conversation panel is the other view", () => {
    expect(defaultOpenTarget(sess({ kind: "terminal", pty: true, adapterSlug: "claude-code" }))).toBe("terminal")
    expect(defaultOpenTarget(sess({ kind: "terminal", pty: true, argv: ["claude"] }))).toBe("terminal")
  })

  it("opens a killed native-conversation PTY on its durable transcript", () => {
    expect(defaultOpenTarget(sess({ kind: "terminal", status: "killed", pty: true, adapterSlug: "claude-code" }))).toBe("transcript")
    expect(defaultOpenTarget(sess({ kind: "terminal", status: "exited", pty: true, argv: ["hermes", "--tui"] }))).toBe("transcript")
    expect(defaultOpenTarget(sess({ kind: "terminal", status: "error", pty: true, argv: ["opencode"] }))).toBe("transcript")
  })

  it("keeps a dead plain shell on the terminal route", () => {
    expect(defaultOpenTarget(sess({ kind: "terminal", status: "killed", pty: true, argv: ["bash"] }))).toBe("terminal")
  })

  it("routes agent-cli sessions to the transcript panel", () => {
    expect(defaultOpenTarget(sess({ kind: "agent-cli" }))).toBe("transcript")
  })

  it("routes command sessions to the transcript panel", () => {
    expect(defaultOpenTarget(sess({ kind: "command" }))).toBe("transcript")
  })
})
