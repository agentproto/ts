/**
 * App-scoped state ledger — an append-only JSONL event log per installed
 * app at `<dataDir>/state/events.jsonl`, plus a fold to a stage-board
 * snapshot. Complements the `app_data_*` plane (app-data.ts): data files
 * are app-writable records; the state ledger is the daemon-owned,
 * agent-UNwritable source of truth for "where is this app in its work"
 * (PLAN-app-trame rule 3: state is written only by the daemon from gate
 * results and approvals — never self-certified by an agent).
 *
 * ## Event envelope
 *
 * One JSON object per line (see `AppStateEventEnvelope`):
 *
 *     { id, ts, appRunId?, stage, item?, kind, by, payload }
 *
 *   - `id`      — ULID (monotonic-ish, sort-friendly; see `ulid`)
 *   - `ts`      — ISO 8601 write timestamp (daemon-assigned)
 *   - `stage`   — the workflow stage the event belongs to (required)
 *   - `item`    — optional per-item sub-key inside the stage
 *   - `kind`    — stage-started | gate-report | approval | stage-done |
 *                 blocked | note
 *   - `by`      — runner | human | policy | system
 *   - `payload` — validated per kind (gate-report needs {ok, exitCode},
 *                 approval needs {approved, who}, blocked needs {reason})
 *
 * Writes are single-line appends with O_APPEND (see `appendAppStateEvent`)
 * so two interleaved appends never clobber each other — each write lands
 * as its own line.
 *
 * ## Fold semantics (see `foldAppStateEvents`)
 *
 * `fold(events)` reduces the ledger to `{ stages, updatedAt }`. Per stage:
 *
 *   - `stage-started`   → status `running`
 *   - `gate-report`     → `ok` keeps/returns to `running`, `!ok` →
 *                         `gated-failed`; payload remembered as `lastGate`
 *   - `blocked`         → `blocked`
 *   - `stage-done`      → `done` — from ANY prior state, including
 *                         `blocked`/`gated-failed` (a later stage-done
 *                         re-opens a blocked stage)
 *   - `approval`        → `approved` (an approval after done marks the
 *                         stage approved; approval is terminal-absorbing
 *                         for the stage)
 *   - `note`            → no status change (records `lastEvent` only)
 *
 * Events carrying `item` drive that item's status inside
 * `stages[stage].items` with the SAME reducer; stage-level status is only
 * moved by item-less events. Every event updates the stage's `lastEvent`.
 *
 * ## Access rule
 *
 * `app_state_append` is deliberately NOT auto-granted to app agents: the
 * daemon's `/mcp` factory strips it from the toolset of any request that
 * carries `?callerSessionId=` (i.e. any daemon-spawned agent session —
 * see index.ts's mcpServerFactory, the same hard-gate plumbing as
 * `denyTools`). It stays callable by the daemon runner (server-side
 * `appendAppStateEvent`) and by UI actions (which reach `/mcp` without a
 * caller session id). Reads (`app_state_get` / `app_state_list`) are
 * open, and `app_status` projects the snapshot read-only. It is also
 * never added to an app's `ui.tools` allowlist by default — a UI that
 * needs to append (e.g. recording a human approval) must explicitly list
 * it, and an agent's copy of the toolset never contains it.
 */

import { mkdir, open, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { InstalledApp } from "./app-registry.js"
import { appDataDir } from "./app-data.js"

/** The tool name that must never reach a spawned agent session. */
export const APP_STATE_APPEND_TOOL_NAME = "app_state_append"

/** Crockford base32 alphabet (ULID). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** ULID — 10 chars of millisecond timestamp + 16 chars of randomness.
 *  Sortable by creation time, like the spec's ULIDs; uses crypto-random
 *  entropy (the modulo over the 32-symbol alphabet is negligible bias for
 *  this use). Exported so tests can assert id shape/uniqueness. */
export function ulid(now: number = Date.now()): string {
  let time = Math.floor(now)
  let ts = ""
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[time % 32] + ts
    time = Math.floor(time / 32)
  }
  const bytes = randomBytes(16)
  let rand = ""
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32]
  return ts + rand
}

export const APP_STATE_KINDS = [
  "stage-started",
  "gate-report",
  "approval",
  "stage-done",
  "blocked",
  "note",
] as const
export type AppStateEventKind = (typeof APP_STATE_KINDS)[number]

export const APP_STATE_ACTORS = ["runner", "human", "policy", "system"] as const
export type AppStateEventActor = (typeof APP_STATE_ACTORS)[number]

/** Per-kind payload requirements (loose — extra keys pass through, since
 *  the payload is otherwise an open `Record<string, unknown>`). */
const gateReportPayload = z
  .object({ ok: z.boolean(), exitCode: z.number() })
  .passthrough()
const approvalPayload = z
  .object({ approved: z.boolean(), who: z.string() })
  .passthrough()
const blockedPayload = z
  .object({ reason: z.string() })
  .passthrough()

const payloadSchema: Record<AppStateEventKind, z.ZodTypeAny> = {
  "stage-started": z.record(z.string(), z.unknown()),
  "gate-report": gateReportPayload,
  approval: approvalPayload,
  "stage-done": z.record(z.string(), z.unknown()),
  blocked: blockedPayload,
  note: z.record(z.string(), z.unknown()),
}

/** The full stored envelope. `appRunId` ties the event to one app_run;
 *  `item` scopes the event to one item inside the stage. */
export const appStateEventSchema = z.object({
  id: z.string().regex(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/, "id must be a ULID"),
  ts: z.string().min(1),
  appRunId: z.string().optional(),
  stage: z.string().min(1),
  item: z.string().min(1).optional(),
  kind: z.enum(APP_STATE_KINDS),
  by: z.enum(APP_STATE_ACTORS),
  payload: z.record(z.string(), z.unknown()),
})
export type AppStateEvent = z.infer<typeof appStateEventSchema>

/** What a caller supplies — `id`/`ts` are daemon-assigned; everything
 *  else is the caller's (validated, including the per-kind payload). */
export const appStateEventInputSchema = appStateEventSchema.omit({ id: true, ts: true })
export type AppStateEventInput = z.infer<typeof appStateEventInputSchema>

/** Sub-directory (under the app's data dir) the ledger lives in. */
export const APP_STATE_DIR = "state"
export const APP_STATE_EVENTS_FILE = "events.jsonl"

/** Absolute path of an installed app's ledger. Always under the app's
 *  `dataDir` (never a caller-supplied path), so a hostile `appId` cannot
 *  relocate it — the id only ever selects the registry record. */
export function appStateEventsPath(app: Pick<InstalledApp, "dir" | "dataDir">): string {
  return join(appDataDir(app), APP_STATE_DIR, APP_STATE_EVENTS_FILE)
}

export class AppAppStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppAppStateError"
  }
}

/** Append one event to the app's ledger. Validates the input (including
 *  the per-kind payload), assigns `id`/`ts`, and writes ONE line with
 *  O_APPEND so concurrent appends never interleave mid-line. Returns the
 *  stored event. fsync's the fd before close (durable across a crash,
 *  cheap at ledger scale). */
export async function appendAppStateEvent(
  app: Pick<InstalledApp, "dir" | "dataDir">,
  input: AppStateEventInput,
): Promise<AppStateEvent> {
  const parsed = appStateEventInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppAppStateError(
      `app_state_append: invalid event — ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    )
  }
  // Per-kind payload requirements — the open `Record<string, unknown>` in
  // the base schema is tightened here by kind (see payloadSchema).
  const payloadCheck = payloadSchema[input.kind].safeParse(input.payload)
  if (!payloadCheck.success) {
    throw new AppAppStateError(
      `app_state_append: invalid ${input.kind} payload — ${payloadCheck.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    )
  }
  const event: AppStateEvent = { ...parsed.data, id: ulid(), ts: new Date().toISOString() }
  // Re-validate the assembled envelope too — cheap insurance that the
  // daemon-assigned fields keep the file schema-honest.
  const checked = appStateEventSchema.safeParse(event)
  if (!checked.success) throw new AppAppStateError(`app_state_append: envelope rejected — ${checked.error.message}`)

  const path = appStateEventsPath(app)
  await mkdir(dirname(path), { recursive: true })
  // Flag "a" → O_APPEND: every write is atomic-append at the OS level, so
  // two overlapping appends produce two intact lines, not interleaved bytes.
  const handle = await open(path, "a")
  try {
    await handle.write(JSON.stringify(event) + "\n", null, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  return event
}

/** Read + parse the app's ledger. Malformed lines (partial write from a
 *  crash, hand-edited file) are SKIPPED and counted, never thrown — the
 *  fold stays usable over a damaged tail. Missing file → empty ledger. */
export async function readAppStateEvents(
  app: Pick<InstalledApp, "dir" | "dataDir">,
): Promise<{ events: AppStateEvent[]; malformedLines: number }> {
  const path = appStateEventsPath(app)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return { events: [], malformedLines: 0 }
  }
  const events: AppStateEvent[] = []
  let malformedLines = 0
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const parsed = appStateEventSchema.safeParse(JSON.parse(trimmed))
      if (parsed.success) events.push(parsed.data)
      else malformedLines++
    } catch {
      malformedLines++
    }
  }
  return { events, malformedLines }
}

/** True when the app has a ledger file on disk (the `app_status` projection
 *  only appears for apps that actually use the ledger). */
export async function appStateLedgerExists(app: Pick<InstalledApp, "dir" | "dataDir">): Promise<boolean> {
  try {
    await stat(appStateEventsPath(app))
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Fold — ledger → snapshot
// ---------------------------------------------------------------------------

export type AppStateStageStatus =
  | "pending"
  | "running"
  | "gated-failed"
  | "blocked"
  | "done"
  | "approved"

export interface AppStateGateRecord {
  ok: boolean
  exitCode: number
  report?: unknown
  ts: string
}

export interface AppStateItemSnapshot {
  status: AppStateStageStatus
  lastEvent?: { id: string; ts: string; kind: AppStateEventKind }
}

export interface AppStateStageSnapshot {
  status: AppStateStageStatus
  items?: Record<string, AppStateItemSnapshot>
  lastGate?: AppStateGateRecord
  lastEvent?: { id: string; ts: string; kind: AppStateEventKind; item?: string }
}

export interface AppStateSnapshot {
  stages: Record<string, AppStateStageSnapshot>
  /** Timestamp of the last event folded in — undefined for an empty ledger. */
  updatedAt: string | undefined
}

/** One reducer step, shared by stage-level and item-level folds. `note`
 *  never changes status. Returns the new status (or the same one). */
function reduceStatus(current: AppStateStageStatus, event: AppStateEvent): AppStateStageStatus {
  switch (event.kind) {
    case "stage-started":
      return "running"
    case "gate-report":
      return event.payload.ok === true ? (current === "pending" ? "running" : current) : "gated-failed"
    case "blocked":
      return "blocked"
    case "stage-done":
      // Re-opens: done from ANY prior state — including blocked/gated-failed.
      return "done"
    case "approval":
      return "approved"
    case "note":
      return current
  }
}

/** Fold a ledger into a stage-board snapshot — the documented, tested
 *  reduction described in the module docblock. Order matters: events are
 *  applied in ledger order (append order), which is the authoritative
 *  sequence. */
export function foldAppStateEvents(events: AppStateEvent[]): AppStateSnapshot {
  const stages: Record<string, AppStateStageSnapshot> = {}
  let updatedAt: string | undefined

  const stageOf = (stage: string): AppStateStageSnapshot => {
    let s = stages[stage]
    if (!s) {
      s = { status: "pending" }
      stages[stage] = s
    }
    return s
  }

  for (const event of events) {
    updatedAt = event.ts
    const stage = stageOf(event.stage)
    // Stage-level status is driven by item-less events; an event WITH an
    // `item` drives that item instead (both update the stage's lastEvent).
    if (event.item === undefined) {
      stage.status = reduceStatus(stage.status, event)
    } else {
      stage.items ??= {}
      const item = stage.items[event.item] ?? { status: "pending" as AppStateStageStatus }
      item.status = reduceStatus(item.status, event)
      item.lastEvent = { id: event.id, ts: event.ts, kind: event.kind }
      stage.items[event.item] = item
    }
    if (event.kind === "gate-report" && event.item === undefined) {
      stage.lastGate = {
        ok: event.payload.ok === true,
        exitCode: typeof event.payload.exitCode === "number" ? event.payload.exitCode : -1,
        ...(event.payload.report !== undefined ? { report: event.payload.report } : {}),
        ts: event.ts,
      }
    }
    stage.lastEvent = {
      id: event.id,
      ts: event.ts,
      kind: event.kind,
      ...(event.item !== undefined ? { item: event.item } : {}),
    }
  }

  return { stages, updatedAt }
}

/** Convenience: read + fold the app's current ledger. */
export async function appStateSnapshot(
  app: Pick<InstalledApp, "dir" | "dataDir">,
): Promise<AppStateSnapshot> {
  const { events } = await readAppStateEvents(app)
  return foldAppStateEvents(events)
}