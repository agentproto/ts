import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import {
  agentMirrorOpeningBanner,
  deadSessionBanner,
  notPtyMessage,
  pickTransport,
  ptyExitBanner,
  ptyUpgradeRejectionBanner,
  reconnectGaveUpBanner,
  reconnectedBanner,
  reconnectingBanner,
  terminalDisplayName,
} from "./terminalSwitch.logic.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: 123,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

describe("pickTransport", () => {
  it("routes pty:true to \"pty\"", () => {
    expect(pickTransport(session({ pty: true }))).toBe("pty")
  })

  it("routes pty:false to \"agent\"", () => {
    expect(pickTransport(session({ pty: false }))).toBe("agent")
  })

  it("routes a missing pty flag to \"agent\"", () => {
    expect(pickTransport(session({}))).toBe("agent")
  })

  it("routes on the pty FLAG, not kind — a restarted agent-cli session with pty:true is \"pty\"", () => {
    expect(pickTransport(session({ kind: "agent-cli", pty: true }))).toBe("pty")
  })

  it("a terminal-kind session without pty:true still routes to \"agent\"", () => {
    expect(pickTransport(session({ kind: "terminal", pty: undefined }))).toBe("agent")
  })
})

describe("terminalDisplayName", () => {
  it("prefers the session label", () => {
    expect(terminalDisplayName(session({ label: "my-session" }))).toBe("agentproto: my-session")
  })

  it("falls back to the friendly adapter · short-id name when there is no label/title (FIX D)", () => {
    expect(terminalDisplayName(session({ id: "abc123", label: undefined }))).toBe(
      "agentproto: agent-cli · abc123",
    )
  })
})

describe("notPtyMessage", () => {
  it("names the session and points at Restart Session / claude --resume", () => {
    const msg = notPtyMessage(session({ label: "my-agent" }))
    expect(msg).toContain("my-agent")
    expect(msg).toContain("no PTY")
    expect(msg).toContain("agentproto: Restart Session")
    expect(msg).toContain("claude --resume")
  })

  it("is wrapped in the dim ANSI SGR codes", () => {
    const msg = notPtyMessage(session())
    expect(msg.startsWith("\x1b[2m")).toBe(true)
    expect(msg.endsWith("\x1b[0m")).toBe(true)
  })
})

describe("deadSessionBanner", () => {
  it("names the session and its terminal status", () => {
    const msg = deadSessionBanner(session({ label: "my-agent", status: "killed" }))
    expect(msg).toContain("my-agent")
    expect(msg).toContain("killed")
    expect(msg).toContain("read-only history")
  })
})

describe("agentMirrorOpeningBanner", () => {
  it("shows the not-PTY explainer for a live session", () => {
    expect(agentMirrorOpeningBanner(session({ status: "running" }))).toBe(
      notPtyMessage(session({ status: "running" })),
    )
  })

  it("shows the dead-session banner for an exited session", () => {
    expect(agentMirrorOpeningBanner(session({ status: "exited" }))).toBe(
      deadSessionBanner(session({ status: "exited" })),
    )
  })

  it("treats killed and error as exited too", () => {
    expect(agentMirrorOpeningBanner(session({ status: "killed" }))).toBe(
      deadSessionBanner(session({ status: "killed" })),
    )
    expect(agentMirrorOpeningBanner(session({ status: "error" }))).toBe(
      deadSessionBanner(session({ status: "error" })),
    )
  })
})

describe("ptyExitBanner", () => {
  it("formats an exit code with no signal", () => {
    expect(ptyExitBanner(0)).toBe("\x1b[2m─ session exited (code 0) ─\x1b[0m")
  })

  it("formats an exit code with a signal", () => {
    expect(ptyExitBanner(1, 9)).toBe("\x1b[2m─ session exited (code 1 signal 9) ─\x1b[0m")
  })
})

describe("ptyUpgradeRejectionBanner", () => {
  it("400 session_not_pty maps to the not-PTY explainer", () => {
    const s = session({ label: "x" })
    expect(ptyUpgradeRejectionBanner(400, s)).toBe(notPtyMessage(s))
  })

  it("410 (exited/killed/error) maps to the dead-session banner, using the descriptor's own status", () => {
    const s = session({ label: "x", status: "error" })
    expect(ptyUpgradeRejectionBanner(410, s)).toBe(deadSessionBanner(s))
  })

  it("404 mentions session_not_found", () => {
    expect(ptyUpgradeRejectionBanner(404, session({ label: "x" }))).toContain("404 session_not_found")
  })

  it("501 mentions pty_not_configured", () => {
    expect(ptyUpgradeRejectionBanner(501, session())).toContain("501 pty_not_configured")
  })

  it("falls back to a generic message for an unrecognised status", () => {
    expect(ptyUpgradeRejectionBanner(500, session())).toBe("\x1b[2m─ terminal connection rejected: HTTP 500. ─\x1b[0m")
  })
})

describe("reconnect banners", () => {
  it("reconnectingBanner reports the attempt count and delay in seconds", () => {
    expect(reconnectingBanner(2, 5, 4_000)).toBe(
      "\x1b[2m─ disconnected · reconnecting in 4s (2/5)… ─\x1b[0m",
    )
  })

  it("reconnectedBanner is a fixed string", () => {
    expect(reconnectedBanner()).toBe("\x1b[2m─ reconnected ─\x1b[0m")
  })

  it("reconnectGaveUpBanner is a fixed string", () => {
    expect(reconnectGaveUpBanner()).toBe("\x1b[2m─ lost connection to the daemon · giving up after retries ─\x1b[0m")
  })
})
