/**
 * Testable controller for a single transcript panel.
 *
 * Renders a session as a structured chat timeline reduced from the daemon's
 * durable per-session structured events (GET /sessions/:id/events), hydrating
 * once and then live-polling from a monotonic `seq` cursor. Sessions with no
 * structured capture (terminal/command, or a daemon that predates the events
 * route) fall back to the raw flattened /stream output.
 *
 * Safety contract (preserved from the original raw-only controller):
 *   - Lines/updates that arrive before the webview finishes loading are
 *     buffered, never lost or overwritten by the initial render.
 *   - Prompts are fire-and-forget (wait=false) with explicit sending/ack/error
 *     feedback, and concurrent sends are suppressed.
 *   - All disposables (focus stream + record feed) are released on dispose.
 *
 * The controller has no direct vscode UI dependencies beyond the focus-stream
 * Disposable — it posts through a PanelMessenger so it can be unit-tested
 * under plain vitest. Markdown/HTML rendering happens HERE (on the host), so
 * the webview stays credential-free and never parses raw daemon content.
 */

import * as vscode from "vscode"

import { NoTranscriptError } from "../client/daemonClient.js"
import type { DaemonClient } from "../client/daemonClient.js"
import { subscribeSse, type SseSubscription } from "../client/sse.js"
import type {
  SessionDescriptor,
  SessionEventRecord,
  SessionStreamLine,
} from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"

import {
  isJsonToolValue,
  presentConversation,
  reduceConversation,
  stringifyToolValue,
  type PresentedConversation,
} from "./conversation.js"
import { diffConversation } from "./conversationPatch.js"
import { ansiToHtml } from "./ansi.js"
import { escapeHtml, renderMarkdown } from "./markdown.js"
import {
  classifySendFailure,
  isExited,
  sendFailureTitle,
  toolIoDocumentName,
} from "./transcript.logic.js"
import type { ExtMessage, PresentedLine } from "./protocol.js"

/** A tool value resolved for opening in an editor tab. */
export interface ToolIoDocument {
  /** Filename — becomes the tab title and drives syntax highlighting. */
  name: string
  /** The FULL value: unclamped, and unescaped because it goes to a document, not innerHTML. */
  text: string
}

export interface PanelMessenger {
  postMessage(msg: ExtMessage): void
}

export interface TranscriptPanelControllerOptions {
  sessionId: string
  initialSession: SessionDescriptor
  client: DaemonClient
  store: SessionStore
  messenger: PanelMessenger
  /**
   * Structured-events poll interval (ms). Defaults to 250 — safe now that a
   * no-op tick posts nothing and a changed tick posts a patch (not a full
   * timeline rebuild); see postPatch/PollingRecordFeed.
   */
  pollIntervalMs?: number
  /** Auto-start the live poll loop after hydration. Defaults to true; tests
   *  disable it and drive {@link pollOnce} manually. */
  autoPoll?: boolean
  /** `fetch` implementation for the SSE record feed (SseRecordFeed → sse.ts).
   *  Defaults to the global `fetch`; tests override it to control the SSE
   *  connection without a real daemon. */
  fetchImpl?: typeof fetch
}

/** Sessions that never drive an agent turn have no structured capture. */
function isRawKind(kind: SessionDescriptor["kind"]): boolean {
  return kind === "terminal" || kind === "command"
}

/**
 * Transport seam for live conversation updates after initial hydration.
 * `TranscriptPanelController` never talks to the transport directly, only
 * through `start`/`dispose`, so swapping the implementation is a one-class
 * change — see `SseRecordFeed` (the live daemon transport, GET
 * /sessions/:id/events/stream) and `PollingRecordFeed` (its fallback, and
 * the only transport for a daemon that predates the stream route).
 */
export interface RecordFeed {
  /** Begin delivering records; onRecords fires with each new, non-empty batch. */
  start(onRecords: (records: readonly SessionEventRecord[]) => void): void
  dispose(): void
}

/**
 * Polls on a fixed interval via a controller-supplied fetch, so the `since`
 * cursor stays a single source of truth shared with the on-demand
 * `pollOnce()` path (see `TranscriptPanelController.fetchNewRecords`) instead
 * of drifting across two independently-tracked cursors. `isActive` is
 * re-checked before each tick so pausing (mode switch, exit, dispose) takes
 * effect without a separate stop/restart dance.
 */
class PollingRecordFeed implements RecordFeed {
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly intervalMs: number,
    private readonly isActive: () => boolean,
    private readonly fetchSince: () => Promise<readonly SessionEventRecord[]>,
  ) {}

  start(onRecords: (records: readonly SessionEventRecord[]) => void): void {
    this.scheduleNext(onRecords)
  }

  private scheduleNext(onRecords: (records: readonly SessionEventRecord[]) => void): void {
    if (this.disposed || !this.isActive()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.fetchSince()
        .then(records => {
          if (!this.disposed && records.length > 0) onRecords(records)
        })
        .finally(() => this.scheduleNext(onRecords))
    }, this.intervalMs)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}

/**
 * SSE transport for `RecordFeed` — `GET /sessions/:id/events/stream`. The
 * daemon replays everything after `since` then switches to live push
 * (http-server.ts owns the exactly-once handoff); this class just forwards
 * each `data:` frame to `onRecords` one record at a time as it arrives.
 *
 * Falls back to `makeFallback()` (a `PollingRecordFeed`) the moment the
 * connection fails to open even once — a 404 (old daemon, no such route), a
 * network error before any bytes came back, or `resolveToken`/`subscribeSse`
 * throwing outright. `onOpen` (see sse.ts) marks "the route exists and
 * accepted us"; once that has fired, a LATER drop is left to `subscribeSse`'s
 * own reconnect/backoff instead of abandoning SSE — by then the daemon is
 * known to support the route, so a transient hiccup isn't a compat signal.
 */
class SseRecordFeed implements RecordFeed {
  private sub: SseSubscription | undefined
  private fallback: RecordFeed | undefined
  private disposed = false
  private opened = false

  constructor(
    private readonly client: DaemonClient,
    private readonly sessionId: string,
    private readonly since: number,
    private readonly makeFallback: () => RecordFeed,
    private readonly fetchImpl: typeof fetch,
  ) {}

  start(onRecords: (records: readonly SessionEventRecord[]) => void): void {
    try {
      const path = `/sessions/${encodeURIComponent(this.sessionId)}/events/stream?since=${this.since}`
      this.client
        .resolveToken()
        .then(token => {
          if (this.disposed || this.fallback) return
          this.sub = subscribeSse(
            `${this.client.url}${path}`,
            token ? { authorization: `Bearer ${token}` } : {},
            {
              onOpen: () => {
                this.opened = true
              },
              onEvent: data => {
                if (this.disposed || this.fallback) return
                const record = data as SessionEventRecord
                if (record && typeof record.seq === "number") onRecords([record])
              },
              onError: () => {
                if (this.disposed || this.fallback || this.opened) return
                this.fallBackToPolling(onRecords)
              },
            },
            this.fetchImpl,
          )
        })
        .catch(() => {
          if (this.disposed || this.fallback) return
          this.fallBackToPolling(onRecords)
        })
    } catch {
      this.fallBackToPolling(onRecords)
    }
  }

  private fallBackToPolling(onRecords: (records: readonly SessionEventRecord[]) => void): void {
    this.sub?.close()
    this.sub = undefined
    this.fallback = this.makeFallback()
    this.fallback.start(onRecords)
  }

  dispose(): void {
    this.disposed = true
    this.sub?.close()
    this.fallback?.dispose()
  }
}

export class TranscriptPanelController {
  private readonly sessionId: string
  private readonly client: DaemonClient
  private readonly messenger: PanelMessenger
  private readonly initialSession: SessionDescriptor
  private readonly focusDisposable: vscode.Disposable
  private readonly pollIntervalMs: number
  private readonly autoPoll: boolean
  private readonly fetchImpl: typeof fetch

  private initSent = false
  private initPromise: Promise<void> | undefined
  private mode: "structured" | "raw" | undefined
  private readonly linesBuffer: SessionStreamLine[] = []
  private pendingSessionUpdate: SessionDescriptor | undefined
  private isSending = false
  private disposed = false
  private exited = false

  // Structured-mode state.
  private readonly records: SessionEventRecord[] = []
  private readonly seenSeqs = new Set<number>()
  private eventsCursor = 0
  private feed: RecordFeed | undefined
  /** Last conversation posted to the webview — the diff base for the next patch. */
  private lastPresented: PresentedConversation | undefined

  private readonly renderers = { renderMarkdown, escapeHtml }

  constructor(opts: TranscriptPanelControllerOptions) {
    this.sessionId = opts.sessionId
    this.client = opts.client
    this.messenger = opts.messenger
    this.initialSession = opts.initialSession
    this.pollIntervalMs = opts.pollIntervalMs ?? 250
    this.autoPoll = opts.autoPoll ?? true
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.exited = isExited(opts.initialSession.status)
    // Open the raw stream up front so pre-ready lines are buffered for the
    // raw fallback. In structured mode these are ignored (see onLine).
    this.focusDisposable = opts.store.focusOutput(opts.sessionId, {
      onLine: line => this.onLine(line),
    })
  }

  onSessionUpdate(session: SessionDescriptor): void {
    this.exited = isExited(session.status)
    if (!this.initSent) {
      this.pendingSessionUpdate = session
      return
    }
    this.messenger.postMessage({ type: "sessionUpdate", session })
    // A lifecycle change (turn-end, exit, …) is a good moment to drain any
    // newly-durable events so the timeline stays responsive between ticks.
    if (this.autoPoll && this.mode === "structured") {
      void this.pollOnce()
    }
  }

  private onLine(line: SessionStreamLine): void {
    // Structured mode renders from events.jsonl, not the flattened stream.
    if (this.mode === "structured") return
    if (!this.initSent) {
      this.linesBuffer.push(line)
      return
    }
    this.messenger.postMessage({ type: "lines", lines: [presentLine(line)] })
  }

  async onReady(): Promise<void> {
    if (this.initSent) return
    if (!this.initPromise) {
      this.initPromise = this.initialize()
    }
    return this.initPromise
  }

  private async initialize(): Promise<void> {
    // The render mode is decided from the best-known descriptor (initial /
    // pre-ready), so the authoritative getSession fetch and the mode-specific
    // content load run concurrently — one round-trip, no serial stall.
    const preSession = this.pendingSessionUpdate ?? this.initialSession
    const [currentSession, loaded] = await Promise.all([
      this.client.getSession(this.sessionId).catch(() => undefined),
      this.loadContent(preSession),
    ])
    const session = currentSession ?? this.pendingSessionUpdate ?? this.initialSession
    this.exited = isExited(session.status)
    this.mode = loaded.mode
    // `init` ships this same snapshot, so the first live update diffs
    // against what the webview actually has instead of treating every turn
    // as new.
    if (loaded.mode === "structured") this.lastPresented = loaded.conversation

    this.messenger.postMessage({
      type: "init",
      session,
      nonce: "",
      mode: loaded.mode,
      ...(loaded.conversation ? { conversation: loaded.conversation } : {}),
      ...(loaded.initialHtml !== undefined ? { initialHtml: loaded.initialHtml } : {}),
    })
    this.initSent = true

    // Forward the latest pre-ready descriptor if it differs from what init
    // already showed, so no field update is dropped.
    if (this.pendingSessionUpdate && this.pendingSessionUpdate.id === session.id) {
      if (!sessionDescriptorsEqual(this.pendingSessionUpdate, session)) {
        this.messenger.postMessage({ type: "sessionUpdate", session: this.pendingSessionUpdate })
      }
      this.pendingSessionUpdate = undefined
    }

    if (this.mode === "raw") {
      if (this.linesBuffer.length > 0) {
        this.messenger.postMessage({
          type: "lines",
          lines: this.linesBuffer.map(presentLine),
        })
        this.linesBuffer.length = 0
      }
    } else {
      // Structured mode ignores the raw stream — drop any buffered lines.
      this.linesBuffer.length = 0
      this.startFeed()
    }
  }

  /** Load initial content for the chosen render mode. Prefers the structured
   *  timeline for agent sessions; a missing route/other daemon error degrades
   *  to raw, while a NoTranscriptError (no events written yet) stays structured
   *  so the poll loop can populate it. */
  private async loadContent(preSession: SessionDescriptor): Promise<{
    mode: "structured" | "raw"
    conversation?: PresentedConversation
    initialHtml?: string
  }> {
    if (isRawKind(preSession.kind)) {
      return { mode: "raw", initialHtml: renderRawContent(await fetchRawContent(this.client, this.sessionId)) }
    }
    try {
      await this.hydrateStructured()
      return { mode: "structured", conversation: this.present() }
    } catch (err) {
      if (err instanceof NoTranscriptError) {
        return { mode: "structured", conversation: this.present() }
      }
      return { mode: "raw", initialHtml: renderRawContent(await fetchRawContent(this.client, this.sessionId)) }
    }
  }

  /** Page through the structured events from the current cursor to the end. */
  private async hydrateStructured(): Promise<void> {
    // Bounded loop: `complete=false` means the page was capped by `limit`.
    for (let guard = 0; guard < 1000; guard++) {
      const page = await this.client.getSessionEvents(this.sessionId, { since: this.eventsCursor })
      this.appendRecords(page.events)
      if (page.nextSeq > this.eventsCursor) this.eventsCursor = page.nextSeq
      if (page.complete) return
    }
  }

  /**
   * One live-poll step: fetch events since the cursor, fold them in, and post
   * a patch if anything actually changed. A transient failure (daemon
   * restart mid-stream) is swallowed — the NEXT poll resumes from the same
   * cursor, so no event is missed or double-applied. Called both on-demand
   * (a lifecycle event wants an eager drain — see `onSessionUpdate`) and, via
   * the same `fetchNewRecords`/`applyRecords` path, from the recurring feed.
   */
  async pollOnce(): Promise<void> {
    if (this.disposed || this.mode !== "structured") return
    this.applyRecords(await this.fetchNewRecords())
  }

  /**
   * Fetch records since the cursor and advance it on success. The single
   * cursor authority shared by `pollOnce()` and the recurring `RecordFeed` —
   * see the class doc on `PollingRecordFeed`.
   */
  private async fetchNewRecords(): Promise<readonly SessionEventRecord[]> {
    let page
    try {
      page = await this.client.getSessionEvents(this.sessionId, { since: this.eventsCursor })
    } catch {
      // NoTranscriptError (events not written yet) or a transient network
      // error — retry on the next tick with the same cursor.
      return []
    }
    if (page.nextSeq > this.eventsCursor) this.eventsCursor = page.nextSeq
    return page.events
  }

  /** Fold newly-fetched records in and post a patch if the presented timeline changed. */
  private applyRecords(records: readonly SessionEventRecord[]): void {
    const added = this.appendRecords(records)
    if (added && !this.disposed) this.postPatch()
  }

  /** Diff against the last posted snapshot and post ONLY when something changed. */
  private postPatch(): void {
    const next = this.present()
    const patch = diffConversation(this.lastPresented, next)
    this.lastPresented = next
    if (patch.empty) return
    this.messenger.postMessage({
      type: "patch",
      upsertTurns: patch.upsertTurns,
      removeTurnIds: patch.removeTurnIds,
      ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
    })
  }

  private startFeed(): void {
    if (!this.autoPoll || this.disposed || this.mode !== "structured") return
    const makePollingFeed = (): RecordFeed =>
      new PollingRecordFeed(
        this.pollIntervalMs,
        () => !this.disposed && this.mode === "structured" && !this.exited,
        () => this.fetchNewRecords(),
      )
    this.feed = new SseRecordFeed(
      this.client,
      this.sessionId,
      this.eventsCursor,
      makePollingFeed,
      this.fetchImpl,
    )
    this.feed.start(records => this.applyRecords(records))
  }

  /** Fold a page of records into the accumulator, de-duplicating by seq.
   *  Returns true if any new record was added. */
  private appendRecords(events: readonly SessionEventRecord[]): boolean {
    let added = false
    for (const ev of events) {
      if (typeof ev.seq !== "number" || this.seenSeqs.has(ev.seq)) continue
      this.seenSeqs.add(ev.seq)
      this.records.push(ev)
      added = true
    }
    return added
  }

  private present(): PresentedConversation {
    const conversation = reduceConversation(this.sessionId, this.records)
    return presentConversation(conversation, this.renderers)
  }

  /**
   * Resolve a tool call's full input/output for opening in an editor.
   *
   * Re-reduces from the accumulated records rather than reading anything the
   * webview sent: the webview only ever held a 3-line escaped preview, and
   * asking it for the full value would be the one place raw daemon content
   * crossed into it. Reducing on a click is cheap and keeps the contract.
   *
   * Returns undefined when the id is unknown or that side of the call has no
   * value yet (a pending call has no result) — the caller says so rather than
   * opening an empty tab.
   */
  resolveToolIo(segmentId: string, field: "input" | "output"): ToolIoDocument | undefined {
    const conversation = reduceConversation(this.sessionId, this.records)
    for (const turn of conversation.turns) {
      for (const seg of turn.segments) {
        if (seg.kind !== "tool" || seg.id !== segmentId) continue
        const value = field === "input" ? seg.arguments : seg.result
        if (value === undefined) return undefined
        return {
          name: toolIoDocumentName(seg.toolName, field, seg.id, isJsonToolValue(value)),
          text: stringifyToolValue(value),
        }
      }
    }
    return undefined
  }

  async onSend(text: string, interrupt: boolean): Promise<void> {
    if (this.isSending) return
    this.isSending = true
    this.messenger.postMessage({ type: "sending" })
    try {
      await this.client.prompt(this.sessionId, text, { interrupt, wait: false })
      this.messenger.postMessage({ type: "sendAck" })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Echo the text back alongside a classification: a mid-turn rejection is
      // not an error the user should see, it's a cue to queue the text and
      // send it when the turn ends (see classifySendFailure).
      const kind = classifySendFailure(message)
      this.messenger.postMessage({
        type: "sendError",
        message,
        kind,
        title: sendFailureTitle(kind),
        text,
      })
    } finally {
      this.isSending = false
    }
  }

  dispose(): void {
    this.disposed = true
    this.feed?.dispose()
    this.focusDisposable.dispose()
  }
}

/**
 * Raw-mode initial content: markdown export, with a preview fallback.
 *
 * The two sources are DIFFERENT FORMATS and must not be conflated — that
 * conflation was the bug. `exportSession` returns markdown; `preview` returns
 * the daemon's `/stream` lines, which `projectEvent` deliberately authors
 * pre-colored with ANSI (`\x1b[36m[tool] …`). Rendering the latter as markdown
 * escaped the ESC bytes without interpreting them, so the escape codes showed
 * up as literal garbage. The caller renders each kind with its own renderer.
 */
type RawContent =
  | { kind: "markdown"; text: string }
  | { kind: "ansi-lines"; lines: string[] }

async function fetchRawContent(client: DaemonClient, id: string): Promise<RawContent> {
  try {
    const exported = await client.exportSession(id, "markdown")
    return { kind: "markdown", text: exported.content ?? "" }
  } catch {
    try {
      const preview = await client.preview(id, 200)
      return { kind: "ansi-lines", lines: preview.lines }
    } catch {
      return { kind: "markdown", text: "" }
    }
  }
}

/**
 * Host-side rendering of one raw-mode stream line: ANSI → styled spans, text
 * HTML-escaped. The webview only ever assigns the result — it never sees the
 * daemon's raw bytes, and never parses them.
 */
function presentLine(line: SessionStreamLine): PresentedLine {
  const text = typeof line.line === "string" ? line.line : String(line.line)
  return { html: ansiToHtml(text, escapeHtml), stream: line.stream ?? "stdout" }
}

/** Render raw-mode initial content to safe HTML, per its actual format. */
function renderRawContent(content: RawContent): string {
  if (content.kind === "markdown") return renderMarkdown(content.text)
  return content.lines.map(line => `<div class="line">${ansiToHtml(line, escapeHtml)}</div>`).join("")
}

function sessionDescriptorsEqual(a: SessionDescriptor, b: SessionDescriptor): boolean {
  const aEntries = Object.entries(a)
  const bEntries = new Map(Object.entries(b))
  if (aEntries.length !== bEntries.size) return false
  for (const [key, value] of aEntries) {
    if (!bEntries.has(key) || bEntries.get(key) !== value) return false
  }
  return true
}
