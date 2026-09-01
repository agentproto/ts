/**
 * Pure, dependency-free reducer for the live-session widget's timeline.
 *
 * This module is imported by BOTH the test suite AND (as a hand-kept
 * inlined copy, since the widget HTML is a self-contained script with no
 * bundler) `live-session-app.ts`'s browser bundle — see the "INLINED
 * REDUCER COPY" section there. Keep this file plain TS (no zod, no node
 * imports, no external deps) so it stays trivially portable to that copy.
 *
 * Consumes the `events.jsonl` vocabulary (`{seq,ts,kind,...}`, one record
 * per line) documented in `.plans/CONTRACT.md`. Unknown `kind`s are ignored
 * (state passes through unchanged) rather than throwing, since new kinds can
 * appear in the transcript before the widget knows how to render them.
 */

export interface TimelineEventRecord {
  seq?: number
  ts?: string | number
  kind: string
  sessionId?: string
  text?: string
  partial?: boolean
  toolCallId?: string
  toolName?: string
  arguments?: unknown
  result?: unknown
  isError?: boolean
  reason?: string
  size?: number
  used?: number
  cost?: number
  tokensIn?: number
  tokensOut?: number
  [key: string]: unknown
}

interface RowBase {
  /** Stable, deterministic key derived from the record's `seq` (falls back
   *  to the row's index when `seq` is absent) — never `Date.now()`/random,
   *  so the same event sequence always reduces to identical row ids. */
  id: string
  seq?: number
  ts?: string | number
  sessionId?: string
}

export interface TextRow extends RowBase {
  kind: "text"
  text: string
  /** Reducer-internal continuation hint: true when the LATEST record folded
   *  into this row was flagged `partial` (an explicitly unterminated debounce
   *  flush, see transcript-writer.ts). This flag is the ONLY glue signal
   *  across an interleave — a non-partial record with no trailing "\n" is the
   *  writer's normal end-of-text-block shape, not a mid-line tear. */
  partial?: boolean
}

export interface ToolCallRow extends RowBase {
  kind: "tool-call"
  toolCallId: string
  toolName: string
  arguments?: unknown
  status: "pending" | "ok" | "error"
  result?: unknown
}

export interface TurnEndRow extends RowBase {
  kind: "turn-end"
  reason?: string
}

export interface UsageInfo {
  size?: number
  used?: number
  cost?: number
  tokensIn?: number
  tokensOut?: number
  /** seq/ts of the record that produced this snapshot — last-write-wins. */
  seq?: number
  ts?: string | number
}

export type TimelineRow = TextRow | ToolCallRow | TurnEndRow

export interface TimelineState {
  rows: TimelineRow[]
  /** Latest known usage snapshot, or null before the first usage_update
   *  record. Not a row — state, updated in place. */
  usage: UsageInfo | null
}

export function initialTimelineState(): TimelineState {
  return { rows: [], usage: null }
}

function rowId(record: TimelineEventRecord, rows: readonly TimelineRow[]): string {
  return record.seq != null ? `${record.kind}-${record.seq}` : `${record.kind}-${rows.length}`
}

/** Fold a text-delta record into an existing row (fresh object — the reducer
 *  is pure), keeping the row's `partial` hint in step with the latest record. */
function mergeTextDelta(row: TextRow, record: TimelineEventRecord): TextRow {
  const merged: TextRow = { ...row, text: row.text + (record.text ?? ""), seq: record.seq, ts: record.ts }
  if (record.partial === true) merged.partial = true
  else delete merged.partial
  return merged
}

/**
 * Reduce one `events.jsonl` record into the next timeline state. Pure: never
 * mutates `state` or the record, always returns a fresh state object (or the
 * same `state` reference for an ignored/unknown kind, so callers can cheaply
 * check `next === prev` to skip a re-render).
 */
export function reduceEvent(state: TimelineState, record: TimelineEventRecord): TimelineState {
  switch (record.kind) {
    case "text-delta": {
      const last = state.rows[state.rows.length - 1]
      if (last && last.kind === "text" && last.sessionId === record.sessionId) {
        return { rows: [...state.rows.slice(0, -1), mergeTextDelta(last, record)], usage: state.usage }
      }
      // The daemon's transcript debounce can flush an unterminated mid-word
      // fragment ("Bien re") flagged `partial: true`, let a tool-call record
      // land, then flush the continuation ("çu — …") — look back within the
      // same turn (bounded by this session's last turn-end) for that
      // session's most recent text row and continue it in place rather than
      // splitting the sentence into a second row after the interleave. Only
      // the explicit `partial` flag glues: the writer's ordering flush emits
      // the END of a text block as a non-partial record with no trailing
      // "\n", so an endsWith("\n") heuristic ran paragraphs together.
      for (let i = state.rows.length - 1; i >= 0; i--) {
        const prior = state.rows[i]!
        if (prior.sessionId !== record.sessionId) continue
        if (prior.kind === "turn-end") break
        if (prior.kind !== "text") continue
        if (prior.partial === true) {
          const rows = [...state.rows]
          rows[i] = mergeTextDelta(prior, record)
          return { rows, usage: state.usage }
        }
        break
      }
      const row: TextRow = {
        kind: "text",
        id: rowId(record, state.rows),
        seq: record.seq,
        ts: record.ts,
        sessionId: record.sessionId,
        text: record.text ?? "",
        ...(record.partial === true ? { partial: true } : {}),
      }
      return { rows: [...state.rows, row], usage: state.usage }
    }

    case "tool-call": {
      const row: ToolCallRow = {
        kind: "tool-call",
        id: rowId(record, state.rows),
        seq: record.seq,
        ts: record.ts,
        sessionId: record.sessionId,
        toolCallId: record.toolCallId ?? "",
        toolName: record.toolName ?? "unknown",
        arguments: record.arguments,
        status: "pending",
      }
      return { rows: [...state.rows, row], usage: state.usage }
    }

    case "tool-result": {
      const idx = state.rows.findIndex(
        r => r.kind === "tool-call" && r.toolCallId === record.toolCallId,
      )
      if (idx === -1) {
        // No matching tool-call in this timeline slice (e.g. it happened
        // before `since`) — still surface the result rather than drop it.
        const row: ToolCallRow = {
          kind: "tool-call",
          id: rowId(record, state.rows),
          seq: record.seq,
          ts: record.ts,
          sessionId: record.sessionId,
          toolCallId: record.toolCallId ?? "",
          toolName: "unknown",
          status: record.isError ? "error" : "ok",
          result: record.result,
        }
        return { rows: [...state.rows, row], usage: state.usage }
      }
      const prior = state.rows[idx] as ToolCallRow
      const updated: ToolCallRow = {
        ...prior,
        status: record.isError ? "error" : "ok",
        result: record.result,
      }
      const rows = state.rows.slice()
      rows[idx] = updated
      return { rows, usage: state.usage }
    }

    case "turn-end": {
      const row: TurnEndRow = {
        kind: "turn-end",
        id: rowId(record, state.rows),
        seq: record.seq,
        ts: record.ts,
        sessionId: record.sessionId,
        reason: record.reason,
      }
      return { rows: [...state.rows, row], usage: state.usage }
    }

    case "usage_update": {
      // Usage is state, not a row — last-write-wins, no merge with the
      // prior snapshot. `state.rows` is reused as-is (it didn't change).
      return {
        rows: state.rows,
        usage: {
          size: record.size,
          used: record.used,
          cost: record.cost,
          tokensIn: record.tokensIn,
          tokensOut: record.tokensOut,
          seq: record.seq,
          ts: record.ts,
        },
      }
    }

    default:
      return state
  }
}

// ── WP1 — scroll decision helper ─────────────────────────────────────

export const SCROLL_STICK_THRESHOLD_PX = 24

/** True when the viewport is close enough to the bottom that new content
 *  should auto-follow. Pure arithmetic — no DOM access — so it's testable
 *  outside a browser and the DOM layer can call it with live element
 *  metrics (`el.scrollHeight`, `el.scrollTop`, `el.clientHeight`). */
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold: number = SCROLL_STICK_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

// ── WP3 — tool-call RLE grouping ────────────────────────────────────

export const TOOL_CALL_GROUP_THRESHOLD = 2

export type RowGroupEntry =
  | { kind: "row"; row: TimelineRow }
  | { kind: "tool-group"; rows: ToolCallRow[] }

/** Walk `rows` once (order preserved) and collapse runs of `threshold`+
 *  adjacent tool-call rows into a single `tool-group` entry. A run breaks
 *  on any non-tool-call row in between (text, turn-end). Non-tool-call rows,
 *  and tool-call runs shorter than `threshold`, pass through as individual
 *  `{kind:"row"}` entries — same order as `rows`. */
export function groupAdjacentToolCalls(
  rows: readonly TimelineRow[],
  threshold: number = TOOL_CALL_GROUP_THRESHOLD,
): RowGroupEntry[] {
  const result: RowGroupEntry[] = []
  let run: ToolCallRow[] = []

  function flushRun() {
    if (run.length >= threshold) {
      result.push({ kind: "tool-group", rows: run })
    } else {
      for (const row of run) {
        result.push({ kind: "row", row })
      }
    }
    run = []
  }

  for (const row of rows) {
    if (row.kind === "tool-call") {
      run.push(row)
    } else {
      flushRun()
      result.push({ kind: "row", row })
    }
  }
  flushRun()

  return result
}

/**
 * Pull a session id out of an ext-apps `ui/notifications/tool-result`
 * payload — the host's push of the tool call that mounted the widget.
 * Handles both wrapping shapes seen in hosts (`params` IS the
 * CallToolResult, or nests it under `params.result`) and both body shapes
 * this widget can be mounted from: an `agent_start` result (a session
 * descriptor whose id lives in `id`) and a `live_session` result
 * (`{sessionId, httpBaseUrl}`). `sessionId` wins over `id` when both are
 * present. Returns `null` for error results, non-JSON text, or any shape
 * mismatch — never throws. A hand-kept inlined copy lives in
 * `live-session-app.ts`'s browser bundle (same convention as the reducer).
 */
export function extractToolResultSessionId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null
  const outer = params as { result?: unknown }
  const res = (
    outer.result && typeof outer.result === "object" ? outer.result : params
  ) as { content?: unknown; isError?: unknown }
  if (res.isError) return null
  const content = Array.isArray(res.content) ? res.content : []
  const item = content[0] as { type?: unknown; text?: unknown } | undefined
  if (!item || item.type !== "text" || typeof item.text !== "string") return null
  try {
    const body = JSON.parse(item.text) as { sessionId?: unknown; id?: unknown }
    if (typeof body?.sessionId === "string" && body.sessionId) return body.sessionId
    if (typeof body?.id === "string" && body.id) return body.id
  } catch {
    // non-JSON tool result (plain-text error message, etc.)
  }
  return null
}
