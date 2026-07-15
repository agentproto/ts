/**
 * Pure routing/naming/banner logic shared by ptyMirror.ts and agentMirror.ts
 * — the "switch" and "honesty in the UI" pieces of the WP5 brief. No
 * `vscode`/`ws` import so this is directly unit-testable.
 */

import type { SessionDescriptor } from "../client/types.js"
import { formatTitle, isExited } from "../webview/transcript.logic.js"

export type TerminalTransport = "pty" | "agent"

/**
 * Route strictly on the `pty` flag, NOT `kind` — a restarted agent-cli
 * session can come back with `pty:true` (pty-native / `claude --resume`)
 * while `kind` stays `"agent-cli"` (see sessionRestart.logic.ts's
 * `describeRestart`), so `kind` alone would misroute it back to the agent
 * mirror.
 */
export function pickTransport(session: SessionDescriptor): TerminalTransport {
  return session.pty === true ? "pty" : "agent"
}

/** Name shown in VS Code's terminal dropdown, e.g. "agentproto: my-session". */
export function terminalDisplayName(session: SessionDescriptor): string {
  return `agentproto: ${formatTitle(session)}`
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`
}

/**
 * Shown once when a terminal opens on an agent-cli session: this shape has
 * NO PTY anywhere (runtime/src/sessions.ts spawns its child with plain
 * pipes — for claude-code the child is `@agentclientprotocol/claude-agent-acp`
 * speaking ACP JSON-RPC, not a TUI). Also reused verbatim by ptyMirror.ts if
 * a WS `/pty` upgrade unexpectedly 400s `session_not_pty` (a stale
 * `pty:true` race), so both entry points say the same thing.
 */
export function notPtyMessage(session: SessionDescriptor): string {
  const label = formatTitle(session)
  return dim(
    `─ ${label} has no PTY — its process speaks ACP over pipes, not a terminal. ` +
      `This view mirrors the agent's streamed output. Run "agentproto: Restart Session" ` +
      `to revive it as a real TUI (claude --resume). ─`,
  )
}

/** Shown for a terminal on a session that has already exited/killed/errored. */
export function deadSessionBanner(session: SessionDescriptor): string {
  return dim(`─ session ${formatTitle(session)} has ${session.status} — this terminal is read-only history. ─`)
}

/** The opening banner for an agent-cli terminal: dead-session framing if it's already over, otherwise the not-PTY explainer. */
export function agentMirrorOpeningBanner(session: SessionDescriptor): string {
  return isExited(session.status) ? deadSessionBanner(session) : notPtyMessage(session)
}

export function ptyExitBanner(exitCode: number, signal?: number): string {
  const sig = signal !== undefined ? ` signal ${signal}` : ""
  return dim(`─ session exited (code ${exitCode}${sig}) ─`)
}

/**
 * Maps a rejected `/pty` WS upgrade's HTTP status to the brief's §5 honesty
 * copy. Deliberately body-blind: the daemon's `rejectUpgrade` writes its
 * JSON body and then `socket.destroy()`s without a `Content-Length` or a
 * graceful `end()` (runtime/src/http-server.ts), so only the status code —
 * not the response body — is safe to rely on. The 410 trio
 * (exited/killed/error) is disambiguated from the session descriptor's own
 * `.status` instead of parsing that body.
 */
export function ptyUpgradeRejectionBanner(status: number, session: SessionDescriptor): string {
  switch (status) {
    case 400:
      return notPtyMessage(session)
    case 410:
      return deadSessionBanner(session)
    case 404:
      return dim(`─ session ${formatTitle(session)} was not found (404 session_not_found). ─`)
    case 501:
      return dim(`─ the daemon has no PTY support configured (501 pty_not_configured). ─`)
    default:
      return dim(`─ terminal connection rejected: HTTP ${status}. ─`)
  }
}

export function reconnectingBanner(attempt: number, max: number, delayMs: number): string {
  return dim(`─ disconnected · reconnecting in ${Math.round(delayMs / 1000)}s (${attempt}/${max})… ─`)
}

export function reconnectedBanner(): string {
  return dim(`─ reconnected ─`)
}

export function reconnectGaveUpBanner(): string {
  return dim(`─ lost connection to the daemon · giving up after retries ─`)
}
