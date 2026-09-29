export interface KeepAlivePolicyOptions {
  now?: () => number
  /** A tab idle longer than this is reapable (unless its session is keepAlive). */
  idleTabMs: number
  /** The browser may shut down after this long with no activity at all. */
  idleBrowserMs: number
}

export type IdleShutdownVerdict =
  | { shutdown: true }
  | { shutdown: false; reason: "keep-alive-session" | "not-idle" }

/**
 * Tab idle-reaper policy. A session marked `keepAlive` (a human login) is
 * never reaped, and its existence blocks idle browser shutdown. Pure state
 * plus an injected clock; the host owns the actual tab close.
 */
export class KeepAlivePolicy {
  private readonly now: () => number
  private readonly idleTabMs: number
  private readonly idleBrowserMs: number
  private readonly sessions = new Map<string, { keepAlive: boolean }>()
  private readonly tabs = new Map<string, { sessionId: string; lastActiveAt: number }>()
  private lastActivityAt: number

  constructor(opts: KeepAlivePolicyOptions) {
    this.now = opts.now ?? Date.now
    this.idleTabMs = opts.idleTabMs
    this.idleBrowserMs = opts.idleBrowserMs
    this.lastActivityAt = this.now()
  }

  registerSession(sessionId: string, opts: { keepAlive?: boolean } = {}): void {
    this.sessions.set(sessionId, { keepAlive: opts.keepAlive === true })
    this.lastActivityAt = this.now()
  }

  endSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    for (const [tabId, tab] of this.tabs) {
      if (tab.sessionId === sessionId) this.tabs.delete(tabId)
    }
  }

  trackTab(tabId: string, sessionId: string): void {
    this.tabs.set(tabId, { sessionId, lastActiveAt: this.now() })
    this.lastActivityAt = this.now()
  }

  touchTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab) tab.lastActiveAt = this.now()
    this.lastActivityAt = this.now()
  }

  untrackTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  isKeepAliveTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    return tab !== undefined && this.sessions.get(tab.sessionId)?.keepAlive === true
  }

  /** Tab ids past the idle limit, never including a keepAlive session's tabs. */
  reapableTabs(): string[] {
    const cutoff = this.now() - this.idleTabMs
    const out: string[] = []
    for (const [tabId, tab] of this.tabs) {
      if (this.isKeepAliveTab(tabId)) continue
      if (tab.lastActiveAt <= cutoff) out.push(tabId)
    }
    return out
  }

  /** Close every reapable tab through `closeTab`; returns the ids closed. */
  async reap(closeTab: (tabId: string) => Promise<void>): Promise<string[]> {
    const closed: string[] = []
    for (const tabId of this.reapableTabs()) {
      await closeTab(tabId)
      this.tabs.delete(tabId)
      closed.push(tabId)
    }
    return closed
  }

  hasKeepAliveSession(): boolean {
    for (const s of this.sessions.values()) if (s.keepAlive) return true
    return false
  }

  /** Idle-browser-shutdown gate: refuses while any keepAlive session exists. */
  shouldShutdownIdleBrowser(): IdleShutdownVerdict {
    if (this.hasKeepAliveSession()) return { shutdown: false, reason: "keep-alive-session" }
    if (this.now() - this.lastActivityAt < this.idleBrowserMs) {
      return { shutdown: false, reason: "not-idle" }
    }
    return { shutdown: true }
  }
}
