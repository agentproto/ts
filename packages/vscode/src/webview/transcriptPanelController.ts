/**
 * Testable controller for a single transcript panel.
 *
 * Owns the init/ready protocol, live-line buffering, and send state so that:
 *   - Lines and session updates that arrive before the webview has finished
 *     loading are not lost or overwritten by the initial render.
 *   - Prompts are sent fire-and-forget (wait=false) with explicit webview
 *     feedback (sending / ack / error).
 *
 * The controller has no direct vscode UI dependencies — it posts messages
 * through a PanelMessenger so it can be unit-tested under plain vitest.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor, SessionStreamLine } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"

import { renderMarkdown } from "./markdown.js"
import type { ExtMessage } from "./protocol.js"

export interface PanelMessenger {
  postMessage(msg: ExtMessage): void
}

export interface TranscriptPanelControllerOptions {
  sessionId: string
  initialSession: SessionDescriptor
  client: DaemonClient
  store: SessionStore
  messenger: PanelMessenger
}

export class TranscriptPanelController {
  private readonly sessionId: string
  private readonly client: DaemonClient
  private readonly messenger: PanelMessenger
  private readonly initialSession: SessionDescriptor
  private readonly focusDisposable: vscode.Disposable

  private initSent = false
  private initPromise: Promise<void> | undefined
  private readonly linesBuffer: SessionStreamLine[] = []
  private pendingSessionUpdate: SessionDescriptor | undefined
  private isSending = false

  constructor(opts: TranscriptPanelControllerOptions) {
    this.sessionId = opts.sessionId
    this.client = opts.client
    this.messenger = opts.messenger
    this.initialSession = opts.initialSession
    this.focusDisposable = opts.store.focusOutput(opts.sessionId, {
      onLine: line => this.onLine(line),
    })
  }

  onSessionUpdate(session: SessionDescriptor): void {
    if (!this.initSent) {
      this.pendingSessionUpdate = session
      return
    }
    this.messenger.postMessage({ type: "sessionUpdate", session })
  }

  private onLine(line: SessionStreamLine): void {
    if (!this.initSent) {
      this.linesBuffer.push(line)
      return
    }
    this.messenger.postMessage({ type: "lines", lines: [line] })
  }

  async onReady(): Promise<void> {
    if (this.initSent) return
    if (!this.initPromise) {
      this.initPromise = this.initialize()
    }
    return this.initPromise
  }

  private async initialize(): Promise<void> {
    const [initialContent, currentSession] = await Promise.all([
      fetchInitialContent(this.client, this.sessionId),
      this.client.getSession(this.sessionId).catch(() => undefined),
    ])
    const session = currentSession ?? this.pendingSessionUpdate ?? this.initialSession
    this.messenger.postMessage({
      type: "init",
      session,
      nonce: "",
      initialHtml: renderMarkdown(initialContent),
    })
    this.initSent = true

    // Forward the latest pre-ready descriptor if it differs from what init
    // already showed, so no field update is dropped.
    if (this.pendingSessionUpdate && this.pendingSessionUpdate.id === session.id) {
      if (!sessionDescriptorsEqual(this.pendingSessionUpdate, session)) {
        this.messenger.postMessage({
          type: "sessionUpdate",
          session: this.pendingSessionUpdate,
        })
      }
      this.pendingSessionUpdate = undefined
    }
    if (this.linesBuffer.length > 0) {
      this.messenger.postMessage({ type: "lines", lines: [...this.linesBuffer] })
      this.linesBuffer.length = 0
    }
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
      this.messenger.postMessage({ type: "sendError", message })
    } finally {
      this.isSending = false
    }
  }

  async onKill(): Promise<void> {
    await this.client.kill(this.sessionId)
  }

  dispose(): void {
    this.focusDisposable.dispose()
  }
}

async function fetchInitialContent(client: DaemonClient, id: string): Promise<string> {
  try {
    const exported = await client.exportSession(id, "markdown")
    return exported.content ?? ""
  } catch {
    try {
      const preview = await client.preview(id, 200)
      return preview.lines.join("\n")
    } catch {
      return ""
    }
  }
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
