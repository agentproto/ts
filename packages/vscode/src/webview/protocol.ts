/**
 * Typed message protocol between the extension host and the transcript
 * webview. All communication happens through `WebviewPanel.webview.postMessage`
 * and `onDidReceiveMessage`.
 */

import type { SessionDescriptor } from "../client/types.js"
import type { ConversationUsage, PresentedConversation, PresentedTurn } from "./conversation.js"

/**
 * A raw-mode transcript line, ALREADY rendered to safe HTML on the host.
 *
 * Carries HTML rather than the daemon's raw `{line, stream}` because those
 * lines are ANSI-colored on purpose — `projectEvent` authors
 * `\x1b[36m[tool] …` so a terminal can render them. The webview must never
 * parse daemon content, so both the ANSI→span conversion and the HTML
 * escaping happen host-side (see webview/ansi.ts) and the webview just
 * assigns the result.
 */
export interface PresentedLine {
  /** ANSI-converted and HTML-escaped — safe to assign to innerHTML. */
  html: string
  /** "stdout" | "stderr" — drives the line's CSS class. */
  stream: string
}

/** Messages sent from the extension host to the webview. */
export type ExtMessage =
  | {
      type: "init"
      /** Current session descriptor used to render the header and input state. */
      session: SessionDescriptor
      /** CSP nonce for the webview's inline script ( echoed back harmlessly). */
      nonce: string
      /**
       * Render mode. "structured" drives the semantic chat timeline from
       * per-session events.jsonl; "raw" is the fallback for terminal/command
       * sessions with no structured capture (flattened /stream output).
       */
      mode: "structured" | "raw"
      /**
       * Structured mode: the initial conversation timeline, ALREADY presented
       * to safe HTML on the extension host (all daemon text escaped via the
       * markdown renderer). The webview renders it structurally and never
       * parses raw content.
       */
      conversation?: PresentedConversation
      /**
       * Raw mode only: initial transcript PRE-RENDERED to safe HTML on the
       * extension host. The webview assigns it to innerHTML — never send
       * unescaped daemon text here.
       */
      initialHtml?: string
    }
  | {
      type: "conversation"
      /**
       * A full conversation resync (structured mode), distinct from `init`'s
       * own `conversation` field so a resync never has to smuggle a session/
       * mode/nonce payload along with it. The live poll loop does NOT use
       * this — it posts `patch` (below) so a tick never rebuilds the whole
       * timeline — but the message stays defined so a full resync (e.g.
       * recovering from a detected divergence) remains representable without
       * overloading `init`.
       */
      conversation: PresentedConversation
    }
  | {
      type: "patch"
      /**
       * Live update (structured mode): only the turns that are new or whose
       * content changed since the last present, in document order. Sent on
       * every poll that advances the cursor; the webview reconciles by
       * stable turn/segment id (see conversation.ts), preserving
       * expand/collapse state and scroll instead of rebuilding the DOM.
       */
      upsertTurns: PresentedTurn[]
      /** Turn ids no longer present (defensive — a re-reduce should not drop turns). */
      removeTurnIds: string[]
      /** Present only when usage changed since the last present. */
      usage?: ConversationUsage
    }
  | {
      type: "lines"
      /** New lines from the focused session's SSE stream (raw mode),
       *  already ANSI-converted + escaped on the host. */
      lines: PresentedLine[]
    }
  | {
      type: "sessionUpdate"
      /** Latest session descriptor (cost, status, tokens, etc.). */
      session: SessionDescriptor
    }
  | { type: "sending" }
  | { type: "sendAck" }
  | { type: "sendError"; message: string }

/** Messages sent from the webview to the extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "interruptSend"; text: string }
  | { type: "kill" }

export function isWebviewMessage(msg: unknown): msg is WebviewMessage {
  if (typeof msg !== "object" || msg === null) return false
  const m = msg as Record<string, unknown>
  const type = m.type
  if (typeof type !== "string") return false
  switch (type) {
    case "ready":
    case "kill":
      return true
    case "send":
    case "interruptSend":
      return typeof m.text === "string"
    default:
      return false
  }
}
