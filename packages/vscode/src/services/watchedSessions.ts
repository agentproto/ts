/**
 * WatchedSessions — the set of session ids the operator has pinned an eye on,
 * persisted per workspace via a Memento.
 *
 * Two jobs:
 *   1. The set itself (`isWatched` / `toggle` / `onDidChange`) — drives the
 *      tree's 👁 prefix, the `-watched` contextValue suffix, and the
 *      watch/unwatch commands' gating.
 *   2. Activity-transition notifications (`attach`): subscribes to the
 *      SessionStore and raises a toast the moment a WATCHED session slides
 *      into needs-you / stalled / parked-bg / failed / done — the states a
 *      parked session would otherwise sit in forever with nobody looking.
 *      The transition rules (which state earns which toast, and the debounce
 *      that keeps one state from re-firing) live in watchedSessions.logic.ts,
 *      pure and unit-tested.
 */

import * as vscode from "vscode"

import type { SessionStore } from "./sessionStore.js"
import { labelFor, activityFor, type SessionActivity } from "../views/sessionsTree.logic.js"
import {
  detectWatchTransitions,
  type WatchActivityMap,
  type WatchTransition,
} from "./watchedSessions.logic.js"

/** workspaceState keys. Bumped only if the value shapes change. */
const WATCHED_KEY = "agentproto.watched.v1"
const ACTIVITY_KEY = "agentproto.watched.activity.v1"

export class WatchedSessions implements vscode.Disposable {
  private watched: Set<string>
  private lastActivity: Map<string, SessionActivity>
  private readonly memento: vscode.Memento
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  constructor(memento: vscode.Memento) {
    this.memento = memento
    this.watched = new Set(memento.get<string[]>(WATCHED_KEY) ?? [])
    const activity = memento.get<WatchActivityMap>(ACTIVITY_KEY) ?? {}
    this.lastActivity = new Map(Object.entries(activity))
  }

  isWatched(id: string): boolean {
    return this.watched.has(id)
  }

  /** Snapshot of the watched id set — for view models that render the eye. */
  get watchedIds(): ReadonlySet<string> {
    return this.watched
  }

  /** Flip the watch state; returns the new state. Fires onDidChange only on a
   *  real change so the tree never repaints for a no-op. */
  toggle(id: string): boolean {
    if (this.watched.has(id)) {
      this.watched.delete(id)
      this.lastActivity.delete(id)
    } else {
      this.watched.add(id)
    }
    void this.memento.update(WATCHED_KEY, [...this.watched])
    void this.memento.update(ACTIVITY_KEY, Object.fromEntries(this.lastActivity))
    this._onDidChange.fire()
    return this.watched.has(id)
  }

  /**
   * Subscribe to the store and toast on watched-session transitions. Returns
   * the subscription so the caller can push it into ctx.subscriptions.
   */
  attach(store: SessionStore): vscode.Disposable {
    return store.onDidChange(() => this.checkTransitions(store))
  }

  private checkTransitions(store: SessionStore): void {
    if (this.watched.size === 0) return
    const current: Record<string, SessionActivity> = {}
    for (const session of store.sessions) {
      if (this.watched.has(session.id)) current[session.id] = activityFor(session, Date.now())
    }
    const transitions = detectWatchTransitions(Object.fromEntries(this.lastActivity), current)
    // Advance the baseline for every watched session still present, whether or
    // not it fired — that's the debounce (one toast per state, not per poll).
    for (const [id, activity] of Object.entries(current)) this.lastActivity.set(id, activity)
    if (transitions.length > 0) {
      void this.memento.update(ACTIVITY_KEY, Object.fromEntries(this.lastActivity))
    }
    for (const transition of transitions) void this.notify(store, transition)
  }

  private async notify(store: SessionStore, transition: WatchTransition): Promise<void> {
    const session = store.sessions.find(s => s.id === transition.sessionId)
    const label = session ? labelFor(session) : transition.sessionId
    const text = `agentproto: ${label} → ${transition.activity}`
    const open = "Open"
    const picked =
      transition.kind === "warning"
        ? await vscode.window.showWarningMessage(text, open)
        : await vscode.window.showInformationMessage(text, open)
    if (picked === open) {
      void vscode.commands.executeCommand("agentproto.openTranscript", transition.sessionId)
    }
  }

  dispose(): void {
    this._onDidChange.dispose()
  }
}
