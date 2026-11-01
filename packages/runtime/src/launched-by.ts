/**
 * "Launched by" is a read-only, derived answer to WHO started a session. The
 * data already lives on the descriptor in four separate fields
 * (`parentSessionId`, `callerSessionId`, `operatorLabel`, `origin`); this
 * module folds them into one `LaunchedBy` value so `session_list` and the CLI
 * table cannot drift. It is pure: no I/O, nothing persisted, no behavior
 * change.
 */

export type LaunchedBy =
  | { kind: "session"; sessionId: string; via?: string }
  | { kind: "operator"; via?: string }
  | { kind: "origin"; origin: string }

/** The raw descriptor fields the derivation reads. */
export interface LaunchedBySource {
  parentSessionId?: string
  callerSessionId?: string
  operatorLabel?: string
  origin?: string
}

const nonEmpty = (v: string | undefined): v is string => v !== undefined && v !== ""

/** Precedence, first match wins: parent, caller, operator, origin. An empty
 *  string counts as absent; a whitespace-only value is kept as given.
 *  `via` (the channel) is attached to the session and operator kinds only,
 *  and only when the origin is non-empty. */
export function launchedByOf(d: LaunchedBySource): LaunchedBy | undefined {
  const via = nonEmpty(d.origin) ? d.origin : undefined
  if (nonEmpty(d.parentSessionId)) {
    return { kind: "session", sessionId: d.parentSessionId, ...(via ? { via } : {}) }
  }
  if (nonEmpty(d.callerSessionId)) {
    return { kind: "session", sessionId: d.callerSessionId, ...(via ? { via } : {}) }
  }
  if (nonEmpty(d.operatorLabel)) {
    return { kind: "operator", ...(via ? { via } : {}) }
  }
  if (nonEmpty(d.origin)) {
    return { kind: "origin", origin: d.origin }
  }
  return undefined
}

/** Human-readable text for a `LaunchedBy`, e.g. `session sess_1 (brain) via
 *  pygmalion`, `operator via vscode`, or `cron`. `labelOf` supplies the
 *  display label for a session id when the caller has one; an empty result
 *  is treated as no label. */
export function launchedByText(
  info: LaunchedBy | undefined,
  labelOf?: (sessionId: string) => string | undefined,
): string {
  if (info === undefined) return ""
  if (info.kind === "origin") return info.origin
  if (info.kind === "operator") return info.via ? `operator via ${info.via}` : "operator"
  const label = labelOf?.(info.sessionId)
  const labelText = label !== undefined && label !== "" ? ` (${label})` : ""
  return `session ${info.sessionId}${labelText}${info.via ? ` via ${info.via}` : ""}`
}
