/**
 * Testable controller for a single transcript panel.
 *
 * Renders a session as a structured chat timeline reduced from the daemon's
 * durable per-session structured events (GET /sessions/:id/events), hydrating
 * once and then live-polling from a monotonic `seq` cursor. Sessions with no
 * structured capture fall back to the raw flattened /stream output; PTY
 * Claude/Hermes sessions can instead bridge to the provider-native transcript
 * and join the structured path.
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

import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

import * as vscode from "vscode"

import { NoTranscriptError } from "../client/daemonClient.js"
import type { DaemonClient } from "../client/daemonClient.js"
import { subscribeSse, type SseSubscription } from "../client/sse.js"
import type {
  CatalogModelsResponse,
  SessionDescriptor,
  SessionEventRecord,
  SessionStreamLine,
} from "../client/types.js"
import { isRouteSwitchable } from "../commands/sessionConfig.logic.js"
import type { SessionStore } from "../services/sessionStore.js"
import { buildAuthHeaders } from "../auth.js"

import {
  isJsonToolValue,
  presentConversation,
  reduceConversation,
  stringifyToolValue,
  type PresentedConversation,
} from "./conversation.js"
import { isNativeConversationSession, loadNativeConversation } from "./nativeConversation.js"
import { canToggleView } from "./viewToggle.logic.js"
import { bridgePtyToWebview } from "./ptyWebviewBridge.js"
import { buildAttachmentName, buildDroppedName, resolveAttachmentsCwd } from "./attachments.logic.js"
import { filterMentionCandidates, type MentionCandidate } from "./mentions.logic.js"
import { listRepoFiles } from "./mentionSource.js"
import { diffConversation } from "./conversationPatch.js"
import { ansiToHtml } from "./ansi.js"
import { escapeHtml, renderMarkdown } from "./markdown.js"
import {
  classifySendFailure,
  isExited,
  sendFailureTitle,
  toolIoDocumentName,
  watcherBannerFor,
} from "./transcript.logic.js"
import { walkResumeChain } from "./resumeChain.logic.js"
import type { ExtMessage, PresentedLine, ResumeChainEntry } from "./protocol.js"

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
  /** Factory for the PTY-mode WebSocket bridge. Defaults to the real
   *  `bridgePtyToWebview`; tests inject a stub to avoid `ws`/daemon traffic. */
  ptyBridgeFactory?: (
    client: DaemonClient,
    session: SessionDescriptor,
    messenger: PanelMessenger,
    initialDims: { cols: number; rows: number },
  ) => { sendInput(text: string): void; resize(cols: number, rows: number): void; dispose(): void }
  /**
   * Delay (ms) before the ONE automatic retry of a send whose prompt POST
   * timed out (see {@link onSend}). Defaults to 3000 — long enough for the
   * daemon's lazy resume to settle, short enough to feel like the same
   * gesture. Tests inject 0 so they don't sleep.
   */
  sendRetryDelayMs?: number
  /**
   * Auto-dismiss delay (ms) for a TRANSIENT cross-session info banner (E3) —
   * the "watcher detached" / "message from another session" ping clears
   * itself after this long (the permanent affordance is the turn badge /
   * watcher count; the banner is only the "something just happened" ping).
   * Defaults to 10 000; tests inject a large value (or drive the timer) so
   * they never wait on it.
   */
  infoBannerAutoDismissMs?: number
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
            buildAuthHeaders(this.client.authHeaders, token),
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
  private readonly ptyBridgeFactory: NonNullable<TranscriptPanelControllerOptions["ptyBridgeFactory"]>
  private readonly sendRetryDelayMs: number
  private readonly infoBannerAutoDismissMs: number

  private initSent = false
  private initPromise: Promise<void> | undefined
  private mode: "structured" | "raw" | "pty" | undefined
  /**
   * User's explicit view choice from the header toggle (FIX 2). Overrides the
   * auto mode pick in {@link loadContent}: `"raw"` forces the terminal view,
   * `"structured"` forces the conversation view. Undefined keeps today's
   * automatic pick so a session that never toggles is unchanged.
   */
  private forcedView: "structured" | "raw" | undefined
  /** The resume ancestry computed once at init — re-sent verbatim on a view
   *  toggle re-render (the ancestry doesn't change when the view flips). */
  private resumeChain: ResumeChainEntry[] | undefined
  private readonly linesBuffer: SessionStreamLine[] = []
  private pendingSessionUpdate: SessionDescriptor | undefined
  private isSending = false
  private disposed = false
  private exited = false
  /** Latest known descriptor — the source of the session cwd used to scope
   *  @mention listing (attachment STORAGE deliberately uses the agentproto home,
   *  not this). Seeded from the initial descriptor, refreshed on every update. */
  private currentSession: SessionDescriptor
  /** Cached @mention file list, recomputed when a fresh mention opens (empty
   *  query) so a new file shows up without re-spawning git on every keystroke. */
  private mentionFiles: string[] | undefined

  // Structured-mode state.
  private readonly records: SessionEventRecord[] = []
  private readonly seenSeqs = new Set<number>()
  private eventsCursor = 0
  private structuredSource: "daemon" | "native" | undefined
  private feed: RecordFeed | undefined
  /** Live PTY WebSocket handle when mode === "pty". */
  private ptyHandle: ReturnType<typeof bridgePtyToWebview> | undefined
  /** Last conversation posted to the webview — the diff base for the next patch. */
  private lastPresented: PresentedConversation | undefined
  /** Model catalog, fetched once and cached — used only to stamp
   *  `routeSwitchable` onto the session so the composer's route chip can dim
   *  when there's a single gateway (chip-pickers). Static-ish, so one fetch. */
  private catalog: CatalogModelsResponse | undefined
  private catalogRequested = false

  // ── Cross-session info banners (E3) ─────────────────────────────────
  /** `watchers` count on the PREVIOUS descriptor — the diff base for the
   *  "a watcher attached/detached" banner. Seeded from the initial
   *  descriptor so hydration doesn't announce a count the panel opened with. */
  private prevWatchers: number
  /** Live auto-dismiss timer for the transient info banner, if one's up. */
  private infoBannerTimer: ReturnType<typeof setTimeout> | undefined

  private readonly renderers = { renderMarkdown, escapeHtml }

  constructor(opts: TranscriptPanelControllerOptions) {
    this.sessionId = opts.sessionId
    this.client = opts.client
    this.messenger = opts.messenger
    this.initialSession = opts.initialSession
    this.currentSession = opts.initialSession
    this.pollIntervalMs = opts.pollIntervalMs ?? 250
    this.autoPoll = opts.autoPoll ?? true
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.ptyBridgeFactory = opts.ptyBridgeFactory ?? bridgePtyToWebview
    this.sendRetryDelayMs = opts.sendRetryDelayMs ?? 3000
    this.infoBannerAutoDismissMs = opts.infoBannerAutoDismissMs ?? 10_000
    this.prevWatchers = opts.initialSession.watchers ?? 0
    this.exited = isExited(opts.initialSession.status)
    // Open the raw stream up front so pre-ready lines are buffered for the
    // raw fallback. In structured mode these are ignored (see onLine).
    this.focusDisposable = opts.store.focusOutput(opts.sessionId, {
      onLine: line => this.onLine(line),
    })
  }

  /** Stamp the UI-computed `routeSwitchable` flag onto a descriptor from the
   *  cached catalog (chip-pickers). Left undefined until the catalog loads. */
  private stampRouteSwitchable(session: SessionDescriptor): SessionDescriptor {
    if (!this.catalog) return session
    return { ...session, routeSwitchable: isRouteSwitchable(this.catalog, session.model) }
  }

  onSessionUpdate(session: SessionDescriptor): void {
    this.exited = isExited(session.status)
    this.currentSession = session
    // Cross-session visibility (E3): the watcher-count diff rides the
    // descriptor the panel already receives — the bus attach/detach events
    // never reach the structured record feed, so the panel diffs the count.
    // Identity is NOT available here (count-only wording); see
    // watcherBannerFor. Runs even pre-init so the diff base advances (an
    // update that lands before init just folds into `pendingSessionUpdate`;
    // a banner fired pre-init is still posted — the webview holds it).
    const watcherText = watcherBannerFor(this.prevWatchers, session.watchers)
    this.prevWatchers = session.watchers ?? 0
    if (watcherText !== undefined) {
      this.postInfoBanner("watcher", watcherText, { autoDismiss: watcherText === "Watcher detached" })
    }
    // Fetch the catalog once (fire-and-forget); until it lands, routeSwitchable
    // is left undefined (chip stays active). Once cached, we re-post so the
    // route chip can settle into its dimmed/active state.
    if (!this.catalogRequested) {
      this.catalogRequested = true
      // Defensive: the catalog is a NICE-TO-HAVE (route-chip dimming), never a
      // reason to break a session update — a client without the method, or a
      // synchronous throw, just leaves routeSwitchable unknown.
      try {
        void this.client
          .catalogModels()
          .then(catalog => {
            this.catalog = catalog
            if (this.initSent && !this.disposed) {
              this.messenger.postMessage({ type: "sessionUpdate", session: this.stampRouteSwitchable(this.currentSession) })
            }
          })
          .catch(() => {})
      } catch {
        /* no catalog support — route chip stays active */
      }
    }
    const stamped = this.stampRouteSwitchable(session)
    if (!this.initSent) {
      this.pendingSessionUpdate = stamped
      return
    }
    this.messenger.postMessage({ type: "sessionUpdate", session: stamped })
    // A lifecycle change (turn-end, exit, …) is a good moment to drain any
    // newly-durable events so the timeline stays responsive between ticks.
    if (this.autoPoll && this.mode === "structured") {
      void this.pollOnce()
    }
  }

  private onLine(line: SessionStreamLine): void {
    // Structured and PTY modes render from their own transports, not the
    // flattened stream.
    if (this.mode === "structured" || this.mode === "pty") return
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
    // pre-ready), so the authoritative getSession fetch, the mode-specific
    // content load, and the resume-chain walk (also keyed off the pre-ready
    // guess — a restarted session's `resumedFrom` doesn't change once set)
    // all run concurrently — one round-trip, no serial stall.
    const preSession = this.pendingSessionUpdate ?? this.initialSession
    const [currentSession, loaded, resumeChain] = await Promise.all([
      this.client.getSession(this.sessionId).catch(() => undefined),
      this.loadContent(preSession),
      preSession.resumedFrom ? this.buildResumeChain(preSession) : Promise.resolve(undefined),
    ])
    const session = currentSession ?? this.pendingSessionUpdate ?? this.initialSession
    this.exited = isExited(session.status)
    this.currentSession = session
    this.mode = loaded.mode
    this.resumeChain = resumeChain
    // `init` ships this same snapshot, so the first live update diffs
    // against what the webview actually has instead of treating every turn
    // as new.
    if (loaded.mode === "structured") {
      this.lastPresented = this.present()
    } else {
      this.lastPresented = undefined
    }

    this.messenger.postMessage({
      type: "init",
      session,
      nonce: "",
      mode: loaded.mode,
      ...(loaded.mode === "structured" ? { conversation: this.lastPresented } : {}),
      ...(loaded.initialHtml !== undefined ? { initialHtml: loaded.initialHtml } : {}),
      ...(resumeChain && resumeChain.length > 0 ? { resumeChain } : {}),
      history: this.promptHistory(),
      ...(canToggleView(session) ? { canToggle: true } : {}),
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
    } else if (this.mode === "pty") {
      // PTY mode has its own WebSocket transport; the flattened stream is not
      // used. Start the bridge after init so the webview is ready to receive.
      this.linesBuffer.length = 0
      this.ptyHandle = this.ptyBridgeFactory(this.client, session, this.messenger, { cols: 80, rows: 24 })
    } else {
      // Structured mode ignores the raw stream — drop any buffered lines.
      this.linesBuffer.length = 0
      this.startFeed()
    }
  }

  /** Load initial content for the chosen render mode. Prefers the structured
   *  timeline for agent sessions; terminal PTYs that map to a known native
   *  conversation store are bridged into the same structured path. A missing
   *  route/other daemon error degrades to raw, while a NoTranscriptError (no
   *  events written yet) stays structured so the poll loop can populate it. */
  private async loadContent(preSession: SessionDescriptor): Promise<{
    mode: "structured" | "raw" | "pty"
    initialHtml?: string
  }> {
    // The header toggle (FIX 2) forces the terminal view: skip the structured
    // path entirely and render the raw flattened stream, even for an
    // agent-cli / native-PTY session that auto would show as a conversation.
    // (`"structured"` needs no special-case — it falls through to today's
    // auto pick, which already chooses structured for exactly those kinds.)
    if (this.forcedView === "raw") {
      this.structuredSource = undefined
      return { mode: "raw", initialHtml: renderRawContent(await fetchRawContent(this.client, this.sessionId)) }
    }
    if (preSession.kind === "agent-cli") {
      this.structuredSource = "daemon"
      try {
        await this.hydrateStructured()
        return { mode: "structured" }
      } catch (err) {
        if (err instanceof NoTranscriptError) {
          return { mode: "structured" }
        }
        this.structuredSource = undefined
        return { mode: "raw", initialHtml: renderRawContent(await fetchRawContent(this.client, this.sessionId)) }
      }
    }
    if (isNativeConversationSession(preSession)) {
      this.structuredSource = "native"
      const records = await loadNativeConversation(preSession)
      this.appendRecords(records)
      this.eventsCursor = records.at(-1)?.seq ?? 0
      return { mode: "structured" }
    }
    // Plain PTY sessions (no native conversation bridge) get the live xterm
    // view, skipping the wasted export+preview round trip.
    if (preSession.kind === "terminal" && preSession.pty === true && !isNativeConversationSession(preSession)) {
      this.structuredSource = undefined
      return { mode: "pty" }
    }
    if (preSession.kind !== "terminal" && preSession.kind !== "command") {
      this.structuredSource = undefined
      return { mode: "raw", initialHtml: renderRawContent(await fetchRawContent(this.client, this.sessionId)) }
    }
    if (preSession.kind === "terminal" && !preSession.pty) {
      this.structuredSource = undefined
      return { mode: "raw", initialHtml: renderRawContent(await fetchRawContent(this.client, this.sessionId)) }
    }
    this.structuredSource = undefined
    return { mode: "raw", initialHtml: renderRawContent(await fetchRawContent(this.client, this.sessionId)) }
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
   * Fetch an ANCESTOR's full structured transcript, paged to completion —
   * the same paging shape as `hydrateStructured`, but deliberately a
   * standalone loop rather than a shared helper: it must NOT touch
   * `this.eventsCursor`/`this.records`, which stay scoped to `this.sessionId`
   * alone (live polling after hydrate only ever advances the CURRENT
   * session's cursor — see the class doc). Propagates `NoTranscriptError`
   * (and anything else) verbatim so `walkResumeChain` can tell "no
   * structured capture" apart from any other fetch failure.
   */
  private async fetchAllEventsFor(sessionId: string): Promise<SessionEventRecord[]> {
    const records: SessionEventRecord[] = []
    let cursor = 0
    for (let guard = 0; guard < 1000; guard++) {
      const page = await this.client.getSessionEvents(sessionId, { since: cursor })
      records.push(...page.events)
      if (page.nextSeq > cursor) cursor = page.nextSeq
      if (page.complete) break
    }
    return records
  }

  /**
   * Walk `session.resumedFrom` backward (resumeChain.logic.ts) and present
   * each ancestor that loaded — the fix for the restart continuity bug: the
   * daemon mints a brand-new session id on restart, whose own events.jsonl
   * starts blank, so without this the prior conversation just vanishes from
   * the panel. Returns segments in CHRONOLOGICAL (oldest-first) order, ready
   * to render top-to-bottom above the current session's own content — the
   * walk itself runs closest-ancestor-first, hence the `reverse()`.
   *
   * Never throws: a failure anywhere in the walk (an unreachable ancestor, a
   * daemon hiccup) is swallowed here so a broken chain degrades to "no
   * history shown" rather than ever blocking `init` on it — `walkResumeChain`
   * itself already turns a per-ancestor failure into an `unavailable`
   * segment instead of rejecting, so this catch is a last-resort backstop
   * (a `getSession` throwing on the STARTING session id, for instance).
   */
  private async buildResumeChain(session: SessionDescriptor): Promise<ResumeChainEntry[]> {
    try {
      const walked = await walkResumeChain(
        { id: session.id, resumedFrom: session.resumedFrom, resumeVia: session.resumeVia },
        {
          getResumeLink: async id => {
            const desc = await this.client.getSession(id)
            return { id: desc.id, resumedFrom: desc.resumedFrom, resumeVia: desc.resumeVia }
          },
          getAllEvents: id => this.fetchAllEventsFor(id),
        },
      )
      return walked
        .map(
          (seg): ResumeChainEntry => ({
            sessionId: seg.sessionId,
            resumeVia: seg.resumeVia,
            ...(seg.records
              ? { conversation: presentConversation(reduceConversation(seg.sessionId, seg.records), this.renderers) }
              : {}),
            ...(seg.unavailable ? { unavailable: seg.unavailable } : {}),
          }),
        )
        .reverse()
    } catch {
      return []
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
    if (this.structuredSource === "native") {
      this.applyRecords(await this.fetchNewNativeRecords())
      return
    }
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

  /** Native PTY bridge: reload the provider transcript and diff by seq. */
  private async fetchNewNativeRecords(): Promise<readonly SessionEventRecord[]> {
    const since = this.eventsCursor
    const records = await loadNativeConversation(this.currentSession)
    if (records.length > since) this.eventsCursor = records.at(-1)?.seq ?? since
    return records.filter(rec => rec.seq > since)
  }

  /** Fold newly-fetched records in and post a patch if the presented timeline changed. */
  private applyRecords(records: readonly SessionEventRecord[]): void {
    const added = this.appendRecords(records)
    // Cross-session visibility (E3): a NEW agent-injected user-prompt is the
    // "something just happened" ping. This path only runs on the LIVE feed /
    // post-hydration poll — hydration folds records via `appendRecords`
    // directly, so a historical agent prompt never re-announces on load.
    // The permanent attribution is the turn badge (E2); this banner is the
    // transient complement.
    if (added) {
      for (const rec of records) {
        if (rec.kind !== "user-prompt" || !rec.source) continue
        const match = /^agent:(.+)$/.exec(rec.source)
        if (match) {
          this.postInfoBanner(`agent-msg:${rec.seq}`, `Message from ${match[1]}`, {
            autoDismiss: true,
          })
        }
      }
    }
    if (added && !this.disposed) this.postPatch()
  }

  /**
   * Post a cross-session INFO banner (E3). Same `id` replaces the current
   * banner (no stacking); a dismissed id may reappear on a new occurrence.
   * `autoDismiss` arms a timer that sends `dismissInfoBanner` after
   * `infoBannerAutoDismissMs` — for the transient "watcher detached" /
   * "message arrived" pings; a "watcher attached" banner stays until the
   * count changes (it describes an ongoing state, not a momentary event).
   */
  private postInfoBanner(id: string, text: string, opts: { autoDismiss?: boolean } = {}): void {
    if (this.disposed) return
    if (this.infoBannerTimer) {
      clearTimeout(this.infoBannerTimer)
      this.infoBannerTimer = undefined
    }
    this.messenger.postMessage({ type: "infoBanner", id, text })
    if (opts.autoDismiss) {
      this.infoBannerTimer = setTimeout(() => {
        this.infoBannerTimer = undefined
        if (!this.disposed) this.messenger.postMessage({ type: "dismissInfoBanner", id })
      }, this.infoBannerAutoDismissMs)
    }
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
    const isActive = () => !this.disposed && this.mode === "structured" && !this.exited
    if (this.structuredSource === "native") {
      this.feed = new PollingRecordFeed(this.pollIntervalMs, isActive, () => this.fetchNewNativeRecords())
      this.feed.start(records => this.applyRecords(records))
      return
    }
    const makePollingFeed = (): RecordFeed =>
      new PollingRecordFeed(this.pollIntervalMs, isActive, () => this.fetchNewRecords())
    this.feed = new SseRecordFeed(this.client, this.sessionId, this.eventsCursor, makePollingFeed, this.fetchImpl)
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
   * Seed the webview's ↑/↓ prompt history from the raw `user-prompt`
   * record texts accumulated in `this.records` — oldest→newest, capped at
   * the same 100 entries `history.logic.ts`'s `pushHistoryEntry` caps at.
   * Raw mode never populates `this.records` (hydrateStructured only runs
   * for structured sessions), so this naturally returns `[]` there and the
   * webview's own local pushes carry history from that point on.
   */
  private promptHistory(): string[] {
    const texts: string[] = []
    for (const rec of this.records) {
      if (rec.kind === "user-prompt" && rec.text) texts.push(rec.text)
    }
    return texts.slice(-100)
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

  /**
   * The best-known session descriptor — the same one the header/composer
   * chips already render from. Public so the changeModel flow (which lives
   * outside this class, alongside its other vscode-UI-facing command
   * counterparts) can read the session's adapter/model/mode without this
   * class growing a `vscode.window.showQuickPick` dependency of its own.
   */
  get session(): SessionDescriptor {
    return this.currentSession
  }

  /**
   * Switch the model on this LIVE session — thin passthrough to
   * `client.setSessionModel` that keeps the sessionId plumbing in one
   * place. Deliberately does NOT touch `currentSession` on success: the
   * chip refreshes from the next daemon-driven `sessionUpdate` (see
   * `onSessionUpdate`), same "never optimistic" contract every other
   * descriptor-driven part of this panel already follows.
   */
  async setModel(
    model: string,
  ): Promise<{ ok: boolean; id: string; applied: boolean; model?: string; reason?: string }> {
    return this.client.setSessionModel(this.sessionId, model)
  }

  async onSend(text: string, interrupt: boolean): Promise<void> {
    if (this.isSending) return
    this.isSending = true
    // Sending to a terminal-status session triggers the daemon's lazy resume
    // (maybeResumeAgent respawns the adapter) — that can take far longer than
    // an ordinary admission, so say so up front instead of letting the user
    // stare at silence.
    this.messenger.postMessage(
      isExited(this.currentSession.status)
        ? { type: "sending", note: "Waking session…" }
        : { type: "sending" },
    )
    try {
      // The prompt route awaits admission even in fire-and-forget mode, so a
      // resume/slow adapter can push the POST past the client timeout — the
      // daemon often completes the send a beat later, which is exactly why a
      // manual retry "worked". Automate that ONE retry on a timeout
      // classification; a genuine refusal (busy/not-alive/other) never
      // retries. isSending stays true for the whole arc so a concurrent
      // onSend is still suppressed during the wait.
      const maxAttempts = 2
      for (let attempt = 1; ; attempt++) {
        try {
          if (this.currentSession.kind === "terminal") {
            // A PTY/terminal session has no agent `prompt` route (that 400s
            // for kind=terminal) — reply flows through the terminal-input
            // broker instead. A terminal has no mid-turn ACP queue, so
            // `interrupt` is a no-op here and is ignored. The native autoPoll
            // reflects the reply back on its own (see
            // pollOnce/fetchNewNativeRecords) — nothing else to do.
            await this.client.writeTerminalInput(this.sessionId, text)
          } else {
            await this.client.prompt(this.sessionId, text, { interrupt, wait: false })
          }
          this.messenger.postMessage({ type: "sendAck" })
          return
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Echo the text back alongside a classification: a mid-turn
          // rejection is not an error the user should see, it's a cue to
          // queue the text and send it when the turn ends (see
          // classifySendFailure).
          const kind = classifySendFailure(message)
          if (kind === "timeout" && attempt < maxAttempts) {
            // First timeout: never leave the user staring at silence — say
            // we're retrying, wait for the daemon's work to land, then resend
            // the SAME text exactly once.
            this.messenger.postMessage({
              type: "sending",
              note: "Session is slow to respond — retrying…",
            })
            await new Promise(resolve => setTimeout(resolve, this.sendRetryDelayMs))
            continue
          }
          if (kind === "busy" && attempt > 1) {
            // The retry landed mid-turn. Given the first attempt TIMED OUT
            // client-side while the daemon's route handler kept running, the
            // overwhelmingly likely story is: the daemon dispatched our first
            // prompt anyway (that's the mechanism behind the timeout), and
            // this retry is what got refused. Treating the 409 as proof the
            // text was delivered — ack and stop here. Posting the busy
            // sendError instead would make the webview QUEUE the same text
            // and re-send it at turn-end, executing the instruction TWICE.
            // Trade-off: in the rare case the turn belongs to a concurrent
            // third-party prompt, the user sees no reply and resends —
            // strictly better than a silent double execution.
            this.messenger.postMessage({ type: "sendAck" })
            return
          }
          this.messenger.postMessage({
            type: "sendError",
            message,
            kind,
            title: sendFailureTitle(kind),
            text,
          })
          return
        }
      }
    } finally {
      this.isSending = false
    }
  }

  /**
   * FIX 2: flip what this panel RENDERS for the SAME session between the
   * structured conversation and the raw terminal — a pure display switch, with
   * NO session restart and NO resume id (distinct from `switchHarness`). Sets
   * {@link forcedView}, tears down the live feed + structured accumulator,
   * re-runs {@link loadContent} under the forced view, re-posts `init` so the
   * webview re-hydrates in the new mode, and re-arms the poll loop. A no-op
   * when the requested view already matches the current mode.
   */
  async onSetView(view: "conversation" | "terminal"): Promise<void> {
    const desired = view === "terminal" ? "raw" : "structured"
    if (this.mode === desired) {
      this.forcedView = desired
      return
    }
    this.forcedView = desired
    // Tear down the live transport and structured accumulator so the reload
    // starts from a clean cursor — the new mode rebuilds its own state.
    this.feed?.dispose()
    this.feed = undefined
    this.ptyHandle?.dispose()
    this.ptyHandle = undefined
    this.records.length = 0
    this.seenSeqs.clear()
    this.eventsCursor = 0
    this.lastPresented = undefined

    const loaded = await this.loadContent(this.currentSession)
    this.mode = loaded.mode
    if (loaded.mode === "structured") this.lastPresented = this.present()

    this.messenger.postMessage({
      type: "init",
      session: this.currentSession,
      nonce: "",
      mode: loaded.mode,
      ...(loaded.mode === "structured" ? { conversation: this.lastPresented } : {}),
      ...(loaded.initialHtml !== undefined ? { initialHtml: loaded.initialHtml } : {}),
      ...(this.resumeChain && this.resumeChain.length > 0 ? { resumeChain: this.resumeChain } : {}),
      // No `history` field: the webview preserves its accumulated ↑/↓ history
      // across a view flip (see the `init` handler) instead of reseeding it.
      ...(canToggleView(this.currentSession) ? { canToggle: true } : {}),
    })

    // Raw mode is fed by the always-open focus stream (onLine); PTY mode by its
    // own WebSocket bridge; only the structured path needs its record feed re-armed.
    if (loaded.mode === "structured") {
      this.startFeed()
    } else if (loaded.mode === "pty") {
      this.ptyHandle = this.ptyBridgeFactory(this.client, this.currentSession, this.messenger, { cols: 80, rows: 24 })
    }
  }

  /**
   * The header title was edited in place (SPEC-3 FIX B). Writes the new name
   * as this session's `label` — the winning display field, so the rename is
   * guaranteed to show over any derived `title`. An empty name clears the
   * label (reverting to the derived/fallback). The live `session:renamed`
   * event flows back through the store, whose `onDidChange` re-posts the
   * descriptor here (updating the header) and repaints the tab + tree — so
   * there's nothing to optimistically patch on this side. A failure propagates
   * to `handleWebviewMessage`'s catch, which surfaces it as an error notice.
   */
  async onRename(name: string): Promise<void> {
    await this.client.renameSession(this.sessionId, { label: name.trim() })
  }

  /** Cancel the in-flight turn — unlike a kill, the session stays alive
   *  and ready for the next prompt. */
  async onStop(): Promise<void> {
    try {
      await this.client.interrupt(this.sessionId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.messenger.postMessage({ type: "stopError", title: "Stop failed", message })
    }
  }

  /**
   * Wired from the webview's `restart` message (composer's Restart button,
   * shown only once the session has exited). Delegates to the SAME command
   * the sessions-tree context menu already uses (sessionRestart.ts) rather
   * than reimplementing it: that command mints the new session id, and —
   * since Task A — the daemon now persists `resumedFrom`/`resumeVia` onto
   * the STORED descriptor, so the transcript it opens picks up the stitched
   * history for free via `buildResumeChain` above. Errors (unreachable
   * daemon, session already gone) surface through that command's own
   * `showErrorMessage` — nothing further to do here.
   */
  async onRestart(): Promise<void> {
    await vscode.commands.executeCommand("agentproto.restartSession", this.sessionId)
  }

  /**
   * A pasted image arrived as raw bytes — the webview can't write disk, so the
   * bytes crossed the boundary and we copy them to a file the agent can read.
   *
   * The file goes to the agentproto home, NOT the session's cwd: a pasted
   * screenshot must not litter the user's git working tree (this overrides the
   * plan's original repo-local choice). The upload route appends its own
   * `.agentproto-attachments/` and returns the absolute path; we hand that path
   * back to the webview to insert as composer TEXT. The prompt therefore stays a
   * plain string — bytes never reach `recordPrompt`, so the transcript stores a
   * short path, not base64. That an agent can Read a path outside its cwd was
   * verified empirically against a live claude-code session before this shipped.
   */
  async onAttachImage(bytes: ArrayBuffer | ArrayBufferView, mime: string): Promise<void> {
    // A clipboard paste has no name of its own → a timestamped one.
    await this.uploadAttachment(bytes, mime, buildAttachmentName(mime, new Date(), shortSuffix()))
  }

  /**
   * A file dragged from the OS filesystem (not the VS Code Explorer) — same
   * store-then-path flow as a paste, but it carries its own name so we keep the
   * human stem (with a uniqueness suffix) instead of a `paste-…` timestamp.
   */
  async onAttachFile(bytes: ArrayBuffer | ArrayBufferView, mime: string, name: string): Promise<void> {
    await this.uploadAttachment(bytes, mime, buildDroppedName(name, mime, shortSuffix()))
  }

  private async uploadAttachment(
    bytes: ArrayBuffer | ArrayBufferView,
    mime: string,
    storedName: string,
  ): Promise<void> {
    const cwd = resolveAttachmentsCwd(process.env, homedir())
    try {
      const { path } = await this.client.uploadFile(cwd, storedName, bytes, mime)
      this.messenger.postMessage({ type: "attachmentUploaded", path })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Never a silent drop — the whole point of the feature is that an
      // attachment the agent can't get is SAID, not swallowed.
      this.messenger.postMessage({ type: "attachError", title: "Attachment upload failed", message })
    }
  }

  /**
   * Answer an `@file` mention query with candidates scoped to the SESSION's cwd
   * (not the editor window — they can differ), honoring `.gitignore`. The list
   * is cached and only recomputed when a fresh mention opens (empty query), so
   * a keystroke-per-request never re-spawns git; the newest query's results are
   * tagged so the webview can drop a stale response.
   */
  async onRequestMentions(query: string): Promise<void> {
    const cwd = this.currentSession.cwd
    if (!cwd) {
      this.messenger.postMessage({ type: "mentionCandidates", query, items: [] })
      return
    }
    if (query.length === 0 || this.mentionFiles === undefined) {
      this.mentionFiles = await listRepoFiles(cwd).catch(() => [])
    }
    const items: MentionCandidate[] = filterMentionCandidates(this.mentionFiles, query, 50).map(rel => ({
      path: join(cwd, rel),
      label: rel,
    }))
    this.messenger.postMessage({ type: "mentionCandidates", query, items })
  }

  dispose(): void {
    this.disposed = true
    if (this.infoBannerTimer) {
      clearTimeout(this.infoBannerTimer)
      this.infoBannerTimer = undefined
    }
    this.feed?.dispose()
    this.ptyHandle?.dispose()
    this.focusDisposable.dispose()
  }

  onPtyInput(text: string): void {
    this.ptyHandle?.sendInput(text)
  }

  onPtyResize(cols: number, rows: number): void {
    this.ptyHandle?.resize(cols, rows)
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

/** A short random token that keeps two same-second/same-name attachments from
 *  colliding on one storage filename. Hex from a CSPRNG — collision-resistant
 *  enough for a filename suffix without pulling in a uuid dep. */
function shortSuffix(): string {
  return randomBytes(3).toString("hex")
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
