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
   *  into this row was flagged `partial` (an explicitly unterminated flush).
   *  Most unterminated debounce flushes carry no flag today, so the
   *  endsWith("\n") check in the reducer is the load-bearing signal. */
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

export interface UsageRow extends RowBase {
  kind: "usage_update"
  size?: number
  used?: number
  cost?: number
  tokensIn?: number
  tokensOut?: number
}

export type TimelineRow = TextRow | ToolCallRow | TurnEndRow | UsageRow

export interface TimelineState {
  rows: TimelineRow[]
}

export function initialTimelineState(): TimelineState {
  return { rows: [] }
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
        return { rows: [...state.rows.slice(0, -1), mergeTextDelta(last, record)] }
      }
      // The daemon's transcript debounce can flush an unterminated mid-word
      // fragment ("Bien re"), let a tool-call record land, then flush the
      // continuation ("çu — …"). Terminated lines carry their trailing "\n"
      // (transcript-writer contract) — so look back within the same turn
      // (bounded by this session's last turn-end) for that session's most
      // recent text row; if it does not end in "\n" (or was explicitly
      // flagged `partial`), continue it in place rather than splitting the
      // sentence into a second row after the interleave.
      for (let i = state.rows.length - 1; i >= 0; i--) {
        const prior = state.rows[i]!
        if (prior.sessionId !== record.sessionId) continue
        if (prior.kind === "turn-end") break
        if (prior.kind !== "text") continue
        if (prior.partial === true || !prior.text.endsWith("\n")) {
          const rows = [...state.rows]
          rows[i] = mergeTextDelta(prior, record)
          return { rows }
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
      return { rows: [...state.rows, row] }
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
      return { rows: [...state.rows, row] }
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
        return { rows: [...state.rows, row] }
      }
      const prior = state.rows[idx] as ToolCallRow
      const updated: ToolCallRow = {
        ...prior,
        status: record.isError ? "error" : "ok",
        result: record.result,
      }
      const rows = state.rows.slice()
      rows[idx] = updated
      return { rows }
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
      return { rows: [...state.rows, row] }
    }

    case "usage_update": {
      const row: UsageRow = {
        kind: "usage_update",
        id: rowId(record, state.rows),
        seq: record.seq,
        ts: record.ts,
        sessionId: record.sessionId,
        size: record.size,
        used: record.used,
        cost: record.cost,
        tokensIn: record.tokensIn,
        tokensOut: record.tokensOut,
      }
      return { rows: [...state.rows, row] }
    }

    default:
      return state
  }
}
