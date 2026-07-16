/**
 * Typed message protocol between the extension host and the transcript
 * webview. All communication happens through `WebviewPanel.webview.postMessage`
 * and `onDidReceiveMessage`.
 */

import type { SessionDescriptor } from "../client/types.js"
import { isBinaryPayload } from "./attachments.logic.js"
import type { ConversationUsage, PresentedConversation, PresentedTurn } from "./conversation.js"
import type { SendFailureKind } from "./transcript.logic.js"

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
  /**
   * A prompt POST was refused. `kind` decides the panel's reaction: "busy"
   * means the agent is mid-turn, which is normal — the panel re-queues `text`
   * and flushes it when the turn ends rather than surfacing an error. Anything
   * else is a real failure and earns the banner. `text` is echoed back so the
   * queue can be rebuilt without the webview having to hold in-flight copies.
   */
  | { type: "sendError"; message: string; kind: SendFailureKind; title: string; text: string }
  /**
   * A pasted image finished uploading — `path` is the absolute on-disk path the
   * agent's Read tool can pick up. The webview inserts it into the composer as
   * text (Decision A: v1 hands over a path, never inline bytes), so the eventual
   * prompt stays a plain string and the transcript records a short line, not
   * base64.
   */
  | { type: "attachmentUploaded"; path: string }
  /**
   * A paste/upload failed (read error, oversize 413, daemon unreachable).
   * Surfaced in the composer's error banner rather than dropped silently — a
   * silent drop is the exact failure mode this feature is built to avoid.
   */
  | { type: "attachError"; title: string; message: string }

/**
 * Messages sent from the webview to the extension host.
 *
 * No `kill`: the composer dropped its Kill button (a permanently-red slab
 * under the user's eyes, for the one action they least often want), and
 * killing a session remains available from the sessions tree via
 * `agentproto.killSession`. Nothing else could ever send this message, so the
 * arm went with the button rather than lingering as unreachable code.
 */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "interruptSend"; text: string }
  /**
   * Open a tool call's full input/output in a read-only editor tab.
   *
   * Carries an id and which side to open — deliberately NOT the text. The
   * webview holds a 3-line preview and nothing else; the host re-derives the
   * full value from its own conversation record. So raw daemon content stays
   * out of the webview even for the values the user explicitly asks to read.
   */
  | { type: "openToolIo"; segmentId: string; field: "input" | "output" }
  /**
   * Raw bytes of a pasted image, headed for `POST /files/upload`. The webview
   * can't write disk, so it structured-clones the ArrayBuffer to the host. Typed
   * as ArrayBuffer|view because the runtime may hand the host either — the guard
   * (`isBinaryPayload`) accepts both so a real paste is never rejected at the
   * boundary, and a base64 STRING never sneaks through as if it were bytes.
   */
  | { type: "attachImage"; bytes: ArrayBuffer | ArrayBufferView; mime: string }

export function isWebviewMessage(msg: unknown): msg is WebviewMessage {
  if (typeof msg !== "object" || msg === null) return false
  const m = msg as Record<string, unknown>
  const type = m.type
  if (typeof type !== "string") return false
  switch (type) {
    case "ready":
      return true
    case "send":
    case "interruptSend":
      return typeof m.text === "string"
    case "openToolIo":
      return typeof m.segmentId === "string" && (m.field === "input" || m.field === "output")
    case "attachImage":
      return isBinaryPayload(m.bytes) && typeof m.mime === "string"
    default:
      return false
  }
}
