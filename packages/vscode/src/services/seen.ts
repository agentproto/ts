/**
 * Read-receipts for session output, persisted per workspace.
 *
 * Answers one question for the sessions tree: has this session produced output
 * the operator hasn't looked at? The rules live in seen.logic.ts; this is the
 * vscode-facing shell — a Memento for persistence and an event so the tree
 * repaints the moment a dot goes hollow.
 */

import * as vscode from "vscode"

import { isUnread, markSeen, type SeenMap } from "./seen.logic.js"
import type { SessionDescriptor } from "../client/types.js"

/** workspaceState key. Bumped only if the value shape changes. */
const SEEN_KEY = "agentproto.seen.v1"

export class SeenTracker implements vscode.Disposable {
  private map: SeenMap
  private readonly memento: vscode.Memento
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  constructor(memento: vscode.Memento) {
    this.memento = memento
    this.map = memento.get<SeenMap>(SEEN_KEY) ?? {}
  }

  isUnread(session: SessionDescriptor): boolean {
    return isUnread(session, this.map[session.id])
  }

  /**
   * Record that the operator has eyes on this session right now.
   *
   * Fires onDidChange only on a real unread→read transition. The panel calls
   * this on every store change while its tab is focused — you are watching the
   * output as it arrives, so it is read as it arrives — and repainting the
   * whole tree for each of those would be churn with nothing to show for it.
   * The receipt itself still advances, so looking away later doesn't resurrect
   * output you already watched.
   */
  markSeen(session: SessionDescriptor, at: number = Date.now()): void {
    const wasUnread = this.isUnread(session)
    const next = markSeen(this.map, session.id, at)
    if (next === this.map) return
    this.map = next
    void this.memento.update(SEEN_KEY, this.map)
    if (wasUnread) this._onDidChange.fire()
  }

  dispose(): void {
    this._onDidChange.dispose()
  }
}
