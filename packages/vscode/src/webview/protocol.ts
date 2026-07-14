/**
 * Typed message protocol between the extension host and the transcript
 * webview. All communication happens through `WebviewPanel.webview.postMessage`
 * and `onDidReceiveMessage`.
 */

import type { SessionDescriptor, SessionStreamLine } from "../client/types.js"

/** Messages sent from the extension host to the webview. */
export type ExtMessage =
  | {
      type: "init"
      /** Current session descriptor used to render the header and input state. */
      session: SessionDescriptor
      /** CSP nonce for the webview's inline script ( echoed back harmlessly). */
      nonce: string
      /** Initial transcript content, rendered as Markdown. */
      initialContent: string
    }
  | {
      type: "lines"
      /** New lines from the focused session's SSE stream. */
      lines: SessionStreamLine[]
    }
  | {
      type: "sessionUpdate"
      /** Latest session descriptor (cost, status, tokens, etc.). */
      session: SessionDescriptor
    }

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
