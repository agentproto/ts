/**
 * Pure Devices webview model — no vscode import so it's unit-testable under
 * plain vitest, same logic/panel split as harnessesWebview.logic.ts /
 * activityWebview.logic.ts.
 *
 * Reshapes `GET /devices` plus a synthetic "this machine" row into the flat
 * row model the webview paints. A host device's nested session list reuses
 * the Sessions tree's own classifier (`activityFor`) and relative-time
 * formatter (`relativeTime`) rather than forking a third status grammar —
 * `Device`/`SessionDescriptor` forwarded from a remote daemon have the exact
 * same shape those functions already classify locally.
 */

import type { Device, SessionDescriptor } from "../client/types.js"
import { activityFor, labelFor, relativeTime, type SessionActivity } from "../views/sessionsTree.logic.js"

/** One row of a device's nested (lazy-loaded) session list. */
export interface DeviceSessionRow {
  id: string
  name: string
  /** Reused verbatim as the row's dot CSS class — same vocabulary as the
   *  Sessions webview's `.dot.<status>` rules. */
  status: SessionActivity
  ageLabel: string
}

/** `sessionsByDevice` entry — mirrors the load lifecycle the panel drives
 *  (fetch on expand, refetch on the view's own refresh cadence). A `loaded`
 *  state is `stale: true` when the host was offline and the daemon served
 *  its last-known-good snapshot instead of a live forward (see
 *  `HostRegistry.getSessionsSnapshot`) — `capturedAt` is that snapshot's
 *  ISO-8601 capture time. Both absent on a live response. */
export type DeviceSessionsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; sessions: readonly SessionDescriptor[]; stale?: boolean; capturedAt?: string }

export interface DeviceWebviewRow {
  /** `"this-machine"` for the synthetic first row, else the device fingerprint. */
  id: string
  isThisMachine: boolean
  name: string
  roleLabel: string
  kindLabel: string
  online: boolean
  /** True when this pairing/host record was granted under a HOST-scoped offer. */
  hostScoped: boolean
  legacy: boolean
  lastSeenLabel: string
  /** Secondary meta line — session count for "this machine", provider/sandbox
   *  + a short fingerprint for a real device. */
  detail: string
  /** Only a `role: "host"` device answers a forwarded `GET /sessions` — a
   *  client-role pairing has nothing to expand into. */
  expandable: boolean
  fingerprint: string | undefined
  /** Present only while `expandable && expanded` — undefined otherwise, so
   *  the panel never sends session state for a row that can't show it. A
   *  `loaded` state's `staleLabel` (e.g. "captured 4m ago") is set only when
   *  `stale` is — pre-formatted with `relativeTime` so the view has nothing
   *  to compute. */
  sessions:
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "loaded"; rows: DeviceSessionRow[]; stale?: boolean; staleLabel?: string }
    | undefined
}

export interface DevicesWebviewModel {
  rows: DeviceWebviewRow[]
}

function shortFingerprint(fp: string): string {
  return fp.length > 12 ? `${fp.slice(0, 10)}…` : fp
}

/** `{pr: "1536", repo: "agentproto/ts"}` -> `"pr=1536, repo=agentproto/ts"` —
 *  self-reported at join time (SANDBOX-VISIBILITY-JOIN #1), so a CI-joined
 *  box reads as more than a raw fingerprint (e.g. which PR spawned it). */
function labelsDetail(labels: Record<string, string> | undefined): string | undefined {
  if (!labels) return undefined
  const rendered = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")
  return rendered || undefined
}

function deviceDetail(d: Device): string {
  const parts: string[] = []
  if (d.provider) parts.push(d.provider)
  if (d.sandboxId) parts.push(d.sandboxId)
  parts.push(shortFingerprint(d.fingerprint))
  const labels = labelsDetail(d.labels)
  if (labels) parts.push(labels)
  return parts.join(" · ")
}

/** Online devices first (the ones actually reachable right now), then by
 *  name — mirrors the harnesses card's ready-first sort. */
function deviceRank(d: Device): number {
  return d.online ? 0 : 1
}

function toDeviceRow(
  d: Device,
  expandedIds: ReadonlySet<string>,
  sessionsByDevice: ReadonlyMap<string, DeviceSessionsState>,
  now: number,
): DeviceWebviewRow {
  const expandable = d.role === "host"
  const expanded = expandable && expandedIds.has(d.fingerprint)
  const state = expanded ? sessionsByDevice.get(d.fingerprint) : undefined
  return {
    id: d.fingerprint,
    isThisMachine: false,
    name: d.name,
    roleLabel: d.role === "host" ? "Host" : "Client",
    kindLabel: d.kind,
    online: d.online,
    hostScoped: d.scope === "host",
    legacy: d.legacy === true,
    lastSeenLabel: relativeTime(d.lastSeen, now),
    detail: deviceDetail(d),
    expandable,
    fingerprint: d.fingerprint,
    sessions: state ? toSessionsState(state, now) : undefined,
  }
}

function toSessionsState(
  state: DeviceSessionsState,
  now: number,
):
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; rows: DeviceSessionRow[]; stale?: boolean; staleLabel?: string } {
  if (state.status !== "loaded") return state
  return {
    status: "loaded",
    rows: buildDeviceSessionRows(state.sessions, now),
    ...(state.stale
      ? { stale: true, staleLabel: `captured ${state.capturedAt ? relativeTime(state.capturedAt, now) : "?"}` }
      : {}),
  }
}

const ACTIVITY_RANK: Record<SessionActivity, number> = {
  "needs-you": 0,
  stalled: 1,
  "parked-bg": 2,
  working: 3,
  idle: 4,
  failed: 5,
  stopped: 6,
  done: 7,
}

/** Shape a host's raw forwarded sessions into rows, busiest activity first —
 *  same urgency ordering `SessionActivity`'s own doc comment defines. */
export function buildDeviceSessionRows(sessions: readonly SessionDescriptor[], now: number): DeviceSessionRow[] {
  return sessions
    .map(s => ({ session: s, activity: activityFor(s, now) }))
    .sort((a, b) => ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity])
    .map(({ session, activity }) => ({
      id: session.id,
      name: labelFor(session),
      status: activity,
      ageLabel: relativeTime(session.startedAt, now),
    }))
}

/** Toggle one id in an expanded-rows set, returning a new Set (never mutates
 *  `current`) — the panel's own state plus a pure helper the tests can drive
 *  directly. */
export function nextExpandedIds(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Rename/revoke/copy-fingerprint are all unavailable on the synthetic "this
 *  machine" row — there is nothing on the daemon to mutate. */
export function canManageDevice(row: Pick<DeviceWebviewRow, "isThisMachine">): boolean {
  return !row.isThisMachine
}

export function buildDevicesWebviewModel(opts: {
  hostname: string
  daemonVersion: string | undefined
  localSessionCount: number
  devices: readonly Device[]
  expandedIds: ReadonlySet<string>
  sessionsByDevice: ReadonlyMap<string, DeviceSessionsState>
  now: number
}): DevicesWebviewModel {
  const thisMachine: DeviceWebviewRow = {
    id: "this-machine",
    isThisMachine: true,
    name: opts.hostname,
    roleLabel: "This machine",
    kindLabel: opts.daemonVersion ? `daemon v${opts.daemonVersion}` : "daemon",
    online: true,
    hostScoped: false,
    legacy: false,
    lastSeenLabel: "active now",
    detail: `${opts.localSessionCount} session${opts.localSessionCount === 1 ? "" : "s"}`,
    expandable: false,
    fingerprint: undefined,
    sessions: undefined,
  }
  const deviceRows = opts.devices
    .slice()
    .sort((a, b) => deviceRank(a) - deviceRank(b) || a.name.localeCompare(b.name))
    .map(d => toDeviceRow(d, opts.expandedIds, opts.sessionsByDevice, opts.now))
  return { rows: [thisMachine, ...deviceRows] }
}
