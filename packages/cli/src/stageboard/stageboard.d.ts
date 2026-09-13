/**
 * Type surface of the served stage board module (`stageboard.js`) — the
 * module itself is plain JavaScript with no build step; this declaration
 * gives TypeScript consumers (tests, typed app UIs) checked access to it.
 */

export interface StageBoardGateRecord {
  ok: boolean
  exitCode: number | null
  findings: unknown
  ts: string | null
}

export interface StageBoardRow {
  item: string | null
  cells: Record<string, string>
  attempts: number
  lastGate: StageBoardGateRecord | null
  appRunId: string | null
}

export interface StageBoardRows {
  columns: string[]
  rows: StageBoardRow[]
}

export interface StageBoardStageSnapshot {
  status?: string
  items?: Record<string, { status?: string }>
  lastGate?: { ok?: boolean; exitCode?: number; report?: unknown; ts?: string }
}

export interface StageBoardSnapshot {
  stages?: Record<string, StageBoardStageSnapshot>
}

export interface StageBoardEvent {
  id?: string
  ts?: string
  appRunId?: string
  stage?: string
  item?: string
  kind?: string
  payload?: unknown
}

/** Pure fold: snapshot + ledger events → board columns/rows (no DOM).
 *  Events are loosely typed — the implementation validates each entry and
 *  skips anything malformed (a damaged ledger tail must not break the board). */
export declare function toRows(
  snapshot: StageBoardSnapshot | null | undefined,
  events?: readonly unknown[],
): StageBoardRows

/** Unwrap nested MCP response shells (CallToolResult → text → JSON …). */
export declare function unwrapToolResult(result: unknown): unknown

export interface StageBoardApproval {
  approvalId?: string
  stage?: string
  note?: string
  [key: string]: unknown
}

export interface StageBoardOptions {
  appId: string
  callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  refreshMs?: number
  onValidate?: () => void | Promise<void>
  onApprove?: (approval: StageBoardApproval) => void | Promise<void>
}

export interface StageBoardHandle {
  refresh(): Promise<void>
  destroy(): void
}

/** Mount a live stage board into an element (or CSS selector). */
export declare function mountStageBoard(el: Element | string, opts: StageBoardOptions): StageBoardHandle
