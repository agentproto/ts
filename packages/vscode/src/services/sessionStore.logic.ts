/**
 * Pure session-state merge logic — NO vscode import. Kept separate from
 * sessionStore.ts (the vscode-aware wrapper) so the event-merge algorithm
 * is unit-testable under plain vitest with a fake client, per the brief's
 * named fork #3.
 *
 * The store holds a Map<sessionId, SessionDescriptor> + an ordered list of
 * PendingPermission. Lifecycle events from session_events_poll mutate the
 * map incrementally; a full listSessions()/listPermissions() snapshot
 * replaces it. All mutators return a boolean indicating whether the state
 * actually changed, so the wrapper can fire onDidChange only when needed.
 */

import type {
  PendingPermission,
  SessionDescriptor,
  SessionLifecycleEvent,
} from "../client/types.js"

export interface StoreSnapshot {
  sessions: SessionDescriptor[]
  permissions: PendingPermission[]
}

export interface SessionStoreState {
  sessions: Map<string, SessionDescriptor>
  permissions: Map<string, PendingPermission>
  /**
   * Optimistic rows for spawns asked for but not yet acknowledged. Held apart
   * from `sessions` on purpose: that map is daemon truth, replaced wholesale by
   * every listSessions() snapshot, so a pending row living in it would be
   * erased by the very next poll — and, worse, would be indistinguishable from
   * a session the daemon actually reported.
   */
  pending: Map<string, SessionDescriptor>
}

export function createStoreState(): SessionStoreState {
  return {
    sessions: new Map(),
    permissions: new Map(),
    pending: new Map(),
  }
}

/**
 * Apply a full listSessions() snapshot. Returns true if anything changed
 * (a new id, a removed id, or a field difference on an existing id).
 */
export function applySessionsSnapshot(
  state: SessionStoreState,
  incoming: readonly SessionDescriptor[],
): boolean {
  let changed = false
  const seen = new Set<string>()
  for (const desc of incoming) {
    if (!desc?.id) continue
    seen.add(desc.id)
    const prev = state.sessions.get(desc.id)
    if (!prev) {
      state.sessions.set(desc.id, desc)
      changed = true
    } else if (!shallowEqual(prev, desc)) {
      state.sessions.set(desc.id, desc)
      changed = true
    }
  }
  // Drop sessions no longer reported by the daemon.
  for (const id of [...state.sessions.keys()]) {
    if (!seen.has(id)) {
      state.sessions.delete(id)
      changed = true
    }
  }
  return changed
}

/**
 * Apply a full listPermissions() snapshot. Returns true if anything changed.
 */
export function applyPermissionsSnapshot(
  state: SessionStoreState,
  incoming: readonly PendingPermission[],
): boolean {
  let changed = false
  const seen = new Set<string>()
  for (const perm of incoming) {
    if (!perm?.id) continue
    seen.add(perm.id)
    const prev = state.permissions.get(perm.id)
    if (!prev || !shallowEqual(prev, perm)) {
      state.permissions.set(perm.id, perm)
      changed = true
    }
  }
  for (const id of [...state.permissions.keys()]) {
    if (!seen.has(id)) {
      state.permissions.delete(id)
      changed = true
    }
  }
  return changed
}

/**
 * Apply ONE lifecycle event from session_events_poll. Returns true if the
 * event caused a state change the UI should refresh on.
 *
 * - turn-end / awaiting-input / command-done → mark the session dirty so
 *   the next snapshot fetch refreshes it (we don't trust the event payload
 *   for the full descriptor; the daemon is authoritative).
 * - exited → flip status + endedAt optimistically (UI updates instantly),
 *   the next poll reconciles.
 * - permission-request → no local mutation; the store re-fetches the
 *   permissions inbox on any permission event (caller decides).
 * - permission-resolved → drop the resolved permission locally.
 */
export function applyLifecycleEvent(
  state: SessionStoreState,
  ev: SessionLifecycleEvent,
): boolean {
  const sid = typeof ev.sessionId === "string" ? ev.sessionId : undefined
  switch (ev.type) {
    case "session:turn-end":
    case "session:awaiting-input":
    case "session:command-done":
      // Optimistic nudge: mark busy=false on turn-end, awaitingInput on
      // awaiting-input. The next poll reconciles the full descriptor.
      if (sid) {
        const prev = state.sessions.get(sid)
        if (prev) {
          const next: SessionDescriptor = { ...prev }
          if (ev.type === "session:turn-end") {
            next.busy = false
            next.awaitingInput = false
            if (typeof ev.ts === "string") next.lastActivityAt = ev.ts
          } else if (ev.type === "session:awaiting-input") {
            next.awaitingInput = true
            next.busy = false
          }
          if (!shallowEqual(prev, next)) {
            state.sessions.set(sid, next)
            return true
          }
        }
      }
      return false

    case "session:exited": {
      if (!sid) return false
      const prev = state.sessions.get(sid)
      if (!prev) return false
      const status =
        ev.status === "killed" || ev.status === "error" ? ev.status : "exited"
      const next: SessionDescriptor = {
        ...prev,
        status,
        endedAt: typeof ev.ts === "string" ? ev.ts : prev.endedAt,
        busy: false,
        awaitingInput: false,
        processAlive: false,
        ...(typeof ev.exitCode === "number" ? { exitCode: ev.exitCode } : {}),
      }
      if (!shallowEqual(prev, next)) {
        state.sessions.set(sid, next)
        return true
      }
      return false
    }

    case "session:permission-request": {
      const pid = typeof ev.permissionId === "string" ? ev.permissionId : undefined
      if (pid && !state.permissions.has(pid)) {
        // Insert a minimal placeholder so the UI shows something immediately;
        // the next listPermissions() poll fills in the full row.
        const placeholder: PendingPermission = {
          id: pid,
          sessionId: sid ?? "",
          toolCallId: pid,
          text: typeof ev.text === "string" ? ev.text : "Permission requested",
          options:
            Array.isArray(ev.options) && ev.options.every(o => o && typeof o.optionId === "string")
              ? (ev.options as PendingPermission["options"])
              : [],
          requestedAt: typeof ev.ts === "string" ? ev.ts : new Date().toISOString(),
          ...(typeof ev.toolName === "string" ? { toolName: ev.toolName } : {}),
        }
        state.permissions.set(pid, placeholder)
        return true
      }
      return false
    }

    case "session:permission-resolved": {
      const pid = typeof ev.permissionId === "string" ? ev.permissionId : undefined
      if (pid && state.permissions.delete(pid)) return true
      return false
    }

    default:
      // policy:* / cron:* events — not relevant to the sessions/permissions
      // views; ignore without firing a change.
      return false
  }
}

/** Snapshot the current state into plain arrays (stable order: insertion). */
export function snapshot(state: SessionStoreState): StoreSnapshot {
  return {
    sessions: [...state.pending.values(), ...state.sessions.values()],
    permissions: [...state.permissions.values()],
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  const av = a as Record<string, unknown>
  const bv = b as Record<string, unknown>
  for (const k of ka) {
    if (av[k] !== bv[k]) return false
  }
  return true
}
