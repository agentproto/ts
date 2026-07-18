/**
 * Typed message protocol between the extension host and the transcript
 * webview. All communication happens through `WebviewPanel.webview.postMessage`
 * and `onDidReceiveMessage`.
 */

import type { SessionDescriptor } from "../client/types.js"
import { isBinaryPayload } from "./attachments.logic.js"
import type { ConversationUsage, PresentedConversation, PresentedTurn } from "./conversation.js"
import type { MentionCandidate } from "./mentions.logic.js"
import type { SendFailureKind } from "./transcript.logic.js"

/**
 * One ancestor segment of a restarted session's resume chain, ALREADY
 * presented to safe HTML on the extension host — same "webview never parses
 * raw content" contract as `conversation` below. Oldest-first order in
 * `init.resumeChain` (the walk itself runs closest-ancestor-first — see
 * `walkResumeChain`, resumeChain.logic.ts — and the controller reverses it
 * before shipping this).
 */
export interface ResumeChainEntry {
  /** The ancestor session's id — shown (shortened) in the divider. */
  sessionId: string
  /** How the NEXT-more-recent session in the chain resumed from this one —
   *  e.g. "resumed via claude --resume", "resumed via ACP", or "" for a
   *  fresh fallback spawn with no continuity established. Drives the
   *  divider's label. */
  resumeVia: string
  /** This ancestor's presented conversation, when its structured transcript
   *  loaded. Absent (with `unavailable` set) when it couldn't. */
  conversation?: PresentedConversation
  /** Set when this ancestor's transcript couldn't be loaded — the walk
   *  stopped here (see `walkResumeChain`'s doc). The panel shows a note
   *  instead of erroring. */
  unavailable?: "no-transcript" | "fetch-error"
}

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
      /**
       * This session's resume ancestry, oldest segment first, present only
       * when the session was spawned by a restart (`SessionDescriptor.
       * resumedFrom`). Independent of `mode` — an ancestor's history renders
       * above the current session's own content (structured OR raw) in its
       * own static block, never mixed into the live-reconciled timeline (see
       * transcriptPanel.ts's `#resume-history`). Absent for a session that
       * wasn't restarted, or when the walk found nothing (e.g. its
       * immediate `resumedFrom` id no longer resolves).
       */
      resumeChain?: ResumeChainEntry[]
      /**
       * Seeded prompt history for ↑/↓ (oldest → newest) — the last 100
       * `user-prompt` record texts from this session, so history survives a
       * panel reload or a daemon restart. Deliberately RAW user text, not
       * daemon output: it is exactly what the user themselves typed, going
       * back into the composer textarea via `.value` and never `innerHTML`.
       * That is why it is exempt from the escape-before-webview rule that
       * governs every other text field in this protocol. Raw mode has no
       * records to seed from — the host sends `[]` and lets the webview's
       * own local pushes carry it from there.
       */
      history?: string[]
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
   * The `@file` candidate list for a mention query, scoped to the session's cwd
   * (honoring `.gitignore`). `query` is echoed back so the webview can discard a
   * response that arrived after the user typed on — only the newest query's
   * results should paint.
   */
  | { type: "mentionCandidates"; query: string; items: MentionCandidate[] }
  /**
   * A `stop` POST was refused. Deliberately NOT `attachError`: a failed stop
   * is not a failed attachment, and the banner copy differs — this earns its
   * own arm rather than overloading one that means something else.
   */
  | { type: "stopError"; title: string; message: string }

/**
 * Messages sent from the webview to the extension host.
 *
 * No `kill`: the composer dropped its Kill button (a permanently-red slab
 * under the user's eyes, for the one action they least often want), and
 * killing a session remains available from the sessions tree via
 * `agentproto.killSession`. `stop` is NOT `kill` — it cancels the in-flight
 * turn and leaves the session alive, which is exactly why it earns a place
 * under the user's eyes where a red Kill slab did not: the worst case of
 * pressing it by accident is losing the current turn's progress, not the
 * whole session.
 */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "interruptSend"; text: string }
  | { type: "stop" }
  /**
   * The composer's "Restart" button (shown only once the session has
   * exited — see transcriptPanel.ts's `refreshComposer`). Targets THIS
   * panel's own session id; the host resolves that from the controller, not
   * from anything the message carries. Mints a new session id via the same
   * `agentproto.restartSession` command the sessions-tree context menu uses
   * (sessionRestart.ts), whose transcript now opens with the resume chain
   * stitched in (see resumeChain.logic.ts + `init.resumeChain`).
   */
  | { type: "restart" }
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
  /**
   * A file dragged from the OS (not the VS Code Explorer) — it carries its own
   * `name` but, like a paste, exists only as bytes the host must store. A file
   * dragged FROM the Explorer never comes this way: it has a real on-disk path
   * and the webview inserts that directly (Decision A1), no upload.
   */
  | { type: "attachFile"; bytes: ArrayBuffer | ArrayBufferView; mime: string; name: string }
  /**
   * Ask the host for `@file` candidates matching `query`, scoped to the
   * session's cwd. The host replies with `mentionCandidates`.
   */
  | { type: "requestMentions"; query: string }
  /**
   * The model chip was clicked — open the mid-session model-switch picker.
   * Carries no payload: the host already holds the session descriptor
   * (adapter/model/mode) and fetches the adapter listing itself, so the
   * webview has nothing useful to add here (and, same as `openToolIo`,
   * never touches daemon data directly).
   */
  | { type: "changeModel" }

export function isWebviewMessage(msg: unknown): msg is WebviewMessage {
  if (typeof msg !== "object" || msg === null) return false
  const m = msg as Record<string, unknown>
  const type = m.type
  if (typeof type !== "string") return false
  switch (type) {
    case "ready":
    case "stop":
    case "restart":
    case "changeModel":
      return true
    case "send":
    case "interruptSend":
      return typeof m.text === "string"
    case "openToolIo":
      return typeof m.segmentId === "string" && (m.field === "input" || m.field === "output")
    case "attachImage":
      return isBinaryPayload(m.bytes) && typeof m.mime === "string"
    case "attachFile":
      return isBinaryPayload(m.bytes) && typeof m.mime === "string" && typeof m.name === "string"
    case "requestMentions":
      return typeof m.query === "string"
    default:
      return false
  }
}
