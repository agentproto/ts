/**
 * Typed message protocol between the extension host and the transcript
 * webview. All communication happens through `WebviewPanel.webview.postMessage`
 * and `onDidReceiveMessage`.
 */

import type { SessionDescriptor, SessionStreamLine } from "../client/types.js"
import type { PresentedConversation } from "./conversation.js"

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
       * Live-updated conversation timeline (structured mode). Sent on every
       * poll that advances the cursor; the webview reconciles by stable
       * segment id, preserving expand/collapse state and scroll.
       */
      conversation: PresentedConversation
    }
  | {
      type: "lines"
      /** New lines from the focused session's SSE stream (raw mode). */
      lines: SessionStreamLine[]
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
