/**
 * Unit tests for the terminal-session list helpers in
 * `commands/sessions.ts` — the pure functions that make `kind:
 * "terminal"` / `pty: true` rows legible in the `agentproto sessions`
 * list and route Enter to the interactive PTY attach instead of the
 * Conversation/Story view:
 *
 *   - isTerminalSession / sessionRowLabel / terminalKindMark decide
 *     how a terminal session is labelled and badged in the lists.
 *   - attachMode picks the PTY WS transport over the SSE stream for a
 *     terminal session.
 *   - decodeWatchKey is the single source of truth for the touch→action
 *     mapping both watch loops share (Enter = attach, `s` = story, …).
 *
 * These are the unit-testable core of the "terminal sessions LISIBLES"
 * + "Enter = attach PTY" + "s = story" deliverables; the actual live
 * keypress/PTY plumbing must be exercised by hand in a real terminal.
 */

import { describe, it, expect } from "vitest"
import {
  isTerminalSession,
  sessionRowLabel,
  terminalKindMark,
  attachMode,
  decodeWatchKey,
} from "../commands/sessions.js"

const terminal = {
  kind: "terminal" as const,
  pty: true,
  id: "sess_1",
  command: "claude --resume abc",
}
const agentCli = {
  kind: "agent-cli" as const,
  pty: false,
  id: "sess_2",
  command: "claude --resume agent-cli-session",
}

describe("isTerminalSession", () => {
  it("flags kind: terminal regardless of pty", () => {
    expect(isTerminalSession({ kind: "terminal", pty: false })).toBe(true)
    expect(isTerminalSession({ kind: "terminal", pty: true })).toBe(true)
  })

  it("flags any session carrying a real PTY, even with a non-terminal kind", () => {
    expect(isTerminalSession({ kind: "agent-cli", pty: true })).toBe(true)
  })

  it("is false for an ordinary agent-cli session", () => {
    expect(isTerminalSession({ kind: "agent-cli", pty: false })).toBe(false)
  })
})

describe("sessionRowLabel", () => {
  it("prefers a human-supplied name over everything", () => {
    expect(
      sessionRowLabel({ ...terminal, name: "local-tui", command: "claude" }),
    ).toBe("local-tui")
  })

  it("labels a terminal session with the command it ran when there is no name", () => {
    // The shareholder case: a supervisor launched via `claude --resume`
    // must read as `claude --resume …`, not as an opaque session id.
    expect(sessionRowLabel(terminal)).toBe("claude --resume abc")
  })

  it("falls back to the id for non-terminal sessions without a name", () => {
    expect(sessionRowLabel(agentCli)).toBe("sess_2")
  })

  it("falls back to the id for a terminal session with no command", () => {
    expect(
      sessionRowLabel({ kind: "terminal", pty: true, id: "sess_9", command: "" }),
    ).toBe("sess_9")
  })
})

describe("terminalKindMark", () => {
  it("marks a PTY terminal session too", () => {
    expect(
      terminalKindMark({ kind: "terminal", pty: true }),
    ).toBe("PTY")
  })

  it("marks a non-PTY terminal session clearly without overclaiming", () => {
    expect(
      terminalKindMark({ kind: "terminal", pty: false }),
    ).toBe("TERM")
  })

  it("is empty for a non-terminal (agent-cli) row", () => {
    expect(terminalKindMark({ kind: "agent-cli", pty: false })).toBe("")
  })
})

describe("attachMode", () => {
  it("routes a PTY session through the interactive WS /sessions/:id/pty attach", () => {
    expect(attachMode({ pty: true })).toBe("pty")
  })

  it("routes a non-PTY session through the SSE line stream", () => {
    expect(attachMode({ pty: false })).toBe("sse")
    expect(attachMode({})).toBe("sse")
  })
})

describe("decodeWatchKey", () => {
  it("maps Enter to attach", () => {
    expect(decodeWatchKey("\r")).toEqual({ kind: "attach" })
    expect(decodeWatchKey("\n")).toEqual({ kind: "attach" })
  })

  it("maps 's' to story — the Conversation/Story access key", () => {
    expect(decodeWatchKey("s")).toEqual({ kind: "story" })
  })

  it("maps the rest of the bound keys", () => {
    expect(decodeWatchKey("m")).toEqual({ kind: "mirror" })
    expect(decodeWatchKey("R")).toEqual({ kind: "restart" })
    expect(decodeWatchKey("K")).toEqual({ kind: "kill" })
    expect(decodeWatchKey("d")).toEqual({ kind: "forget" })
    expect(decodeWatchKey("r")).toEqual({ kind: "refresh" })
  })

  it("maps movement keys (arrows + j/k)", () => {
    expect(decodeWatchKey("\x1b[A")).toEqual({ kind: "up" })
    expect(decodeWatchKey("k")).toEqual({ kind: "up" })
    expect(decodeWatchKey("\x1b[B")).toEqual({ kind: "down" })
    expect(decodeWatchKey("j")).toEqual({ kind: "down" })
  })

  it("maps q and Ctrl-C to quit", () => {
    expect(decodeWatchKey("q")).toEqual({ kind: "quit" })
    expect(decodeWatchKey("\x03")).toEqual({ kind: "quit" })
  })

  it("returns null for anything unrecognised", () => {
    expect(decodeWatchKey("x")).toBeNull()
    expect(decodeWatchKey("")).toBeNull()
  })
})

describe("key → attach routing for terminal vs agent-cli", () => {
  // Enter decodes to { attach } for BOTH kinds; the terminal-vs-agent-cli
  // split happens downstream in attachMode. This composes the two pure
  // functions to prove: Enter on a terminal session lands on the PTY.
  it("Enter on a terminal (pty) session attaches the interactive PTY", () => {
    const action = decodeWatchKey("\r")
    expect(action).toEqual({ kind: "attach" })
    expect(attachMode(terminal)).toBe("pty")
  })

  it("Enter on an agent-cli session attaches the SSE stream", () => {
    const action = decodeWatchKey("\r")
    expect(action).toEqual({ kind: "attach" })
    expect(attachMode(agentCli)).toBe("sse")
  })
})