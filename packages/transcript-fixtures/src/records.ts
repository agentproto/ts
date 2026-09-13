/**
 * RAW daemon-transcript record types — the canonical producer.
 *
 * These mirror the exact object shapes the daemon's transcript writer emits
 * to disk (`~/.agentproto/sessions/<sessionId>/events.jsonl`) as verified in
 * `packages/runtime/src/transcript-writer.ts`. Every record carries
 * `{seq: number, ts: string (ISO)}` plus kind-specific fields.
 *
 * This is the RAW format produced by the daemon — NOT the normalized
 * client-side format (`normalize.ts` in agentik-studio's
 * `packages/react-agentproto` owns that). The point of this package is to be
 * the single source of truth both sides test against.
 *
 * Zero runtime dependencies: these are just typed data.
 */

/** Every on-disk record begins with a monotonic sequence number and an ISO
 *  timestamp, then kind-specific fields. */
export interface AgentprotoRawTranscriptBase {
  /** Monotonic, ascending per session, starting at 1. */
  seq: number
  /** ISO-8601 timestamp (e.g. `new Date().toISOString()`). */
  ts: string
  /** The discriminator that selects which record type this is. */
  kind: string
}

export interface AgentprotoRawUserPrompt extends AgentprotoRawTranscriptBase {
  kind: "user-prompt"
  sessionId: string
  text: string
  /** Optional provenance, e.g. `agent:<sessionId>` for a supervisor-injected prompt. */
  source?: string
}

export interface AgentprotoRawThought extends AgentprotoRawTranscriptBase {
  kind: "thought"
  sessionId: string
  text: string
  /** `true` on a still-buffered fragment written on the debounce timer; the
   *  final (flush-buffer) record omits it. */
  partial?: true
}

export interface AgentprotoRawTextDelta extends AgentprotoRawTranscriptBase {
  kind: "text-delta"
  sessionId: string
  text: string
  /** `true` on a still-buffered fragment; the final flush omits it. */
  partial?: true
}

export interface AgentprotoRawToolCall extends AgentprotoRawTranscriptBase {
  kind: "tool-call"
  sessionId: string
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
  /** `true` marks an ENRICHMENT (superseding snapshot) of an already-announced
   *  call rather than a genuine second call. A plain announcement omits it. */
  isUpdate?: true
}

export interface AgentprotoRawToolResult extends AgentprotoRawTranscriptBase {
  kind: "tool-result"
  sessionId: string
  toolCallId: string
  /** RAW result — NOT yet wrapped in an `{ output }` envelope. */
  result: unknown
  isError?: boolean
}

export interface AgentprotoRawToolCallRecord extends AgentprotoRawTranscriptBase {
  kind: "tool-call-record"
  sessionId: string
  tool: string
  command?: string
  args?: unknown
  isError: boolean
  durationMs?: number
  createdPrUrl?: string
  createdPrNumber?: number
}

export interface AgentprotoRawPermissionResolved extends AgentprotoRawTranscriptBase {
  kind: "permission-resolved"
  sessionId: string
  toolCallId: string
  decision: string
  optionId?: string
}

export interface AgentprotoRawTurnEnd extends AgentprotoRawTranscriptBase {
  kind: "turn-end"
  sessionId: string
  reason?: string
}

/** A daemon-side system notice (not agent output). Deliberately NOT consumed
 *  explicitly by agentik-studio's `normalize.ts` — it falls through to its
 *  `"other"` fallback, and so exercises the "unknown kind" behavior of both
 *  consumer test suites. */
export interface AgentprotoRawNotice extends AgentprotoRawTranscriptBase {
  kind: "notice"
  sessionId: string
  text: string
}

/** High-frequency cost/context bookkeeping, written on essentially every
 *  turn (`transcript-writer.ts`'s `recordEvent` "usage_update" case).
 *  Modeled here (it is a KNOWN kind, not an unrecognized one) but
 *  deliberately excluded from `CANONICAL_SESSION_RECORDS` below — a
 *  consumer's handling of it is a plain no-op, unit-tested directly rather
 *  than via the shared fixture, to avoid dragging every consumer's
 *  round-trip test into a bookkeeping record that carries no rendering
 *  semantics. */
export interface AgentprotoRawUsageUpdate extends AgentprotoRawTranscriptBase {
  kind: "usage_update"
  sessionId: string
  size: number
  used: number
  cost?: { amount: number; currency: string }
  tokensIn?: number
  tokensOut?: number
}

/** Durable usage recap at a turn boundary (`transcript-writer.ts`'s
 *  `recordUsageSnapshot`) — same "known bookkeeping kind, no-op for
 *  consumers, unit-tested directly" status as {@link AgentprotoRawUsageUpdate}. */
export interface AgentprotoRawUsageSnapshot extends AgentprotoRawTranscriptBase {
  kind: "usage_snapshot"
  sessionId: string
  model?: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  source: string
}

/** The union of every RAW record kind the daemon transcript writer emits —
 *  see each member's doc comment for whether it's covered by
 *  `CANONICAL_SESSION_RECORDS`. */
export type AgentprotoRawTranscriptRecord =
  | AgentprotoRawUserPrompt
  | AgentprotoRawThought
  | AgentprotoRawTextDelta
  | AgentprotoRawToolCall
  | AgentprotoRawToolResult
  | AgentprotoRawToolCallRecord
  | AgentprotoRawPermissionResolved
  | AgentprotoRawTurnEnd
  | AgentprotoRawNotice
  | AgentprotoRawUsageUpdate
  | AgentprotoRawUsageSnapshot

/** `CANONICAL_SESSION` — the shared session id for every record in the
 *  canonical fixture. */
export const CANONICAL_SESSION_ID = "sess_fixture_canonical"

/**
 * The canonical fixture as a typed array — THE single source of truth.
 *
 * The committed `fixtures/canonical-session.jsonl` file is generated from
 * this array by `pnpm --filter @agentproto/transcript-fixtures
 * generate:fixtures` (which loads the built `dist` and writes the file), and
 * the test suite round-trips the on-disk file back against this array, so
 * there can never be two divergent sources.
 *
 * Records are in ascending `seq` (1, 2, 3, …), all sharing
 * `CANONICAL_SESSION_ID`, and together cover every kind at least once.
 */
export const CANONICAL_SESSION_RECORDS: AgentprotoRawTranscriptRecord[] = [
  {
    seq: 1,
    ts: "2026-08-17T09:00:00.000Z",
    kind: "user-prompt",
    sessionId: CANONICAL_SESSION_ID,
    text: "Début d'une session de démonstration : peux-tu inspecter le dépôt et créer une pull request de nettoyage ?",
    source: "human",
  },
  {
    seq: 2,
    ts: "2026-08-17T09:00:01.000Z",
    kind: "thought",
    sessionId: CANONICAL_SESSION_ID,
    text: "Je dois d'abord regarder l'état du dépôt avant de proposer des changements.",
    partial: true,
  },
  {
    seq: 3,
    ts: "2026-08-17T09:00:01.400Z",
    kind: "thought",
    sessionId: CANONICAL_SESSION_ID,
    text: "Je dois d'abord regarder l'état du dépôt avant de proposer des changements.\n",
  },
  {
    seq: 4,
    ts: "2026-08-17T09:00:01.800Z",
    kind: "text-delta",
    sessionId: CANONICAL_SESSION_ID,
    text: "Bien sûr, je vais commencer",
    partial: true,
  },
  {
    seq: 5,
    ts: "2026-08-17T09:00:02.200Z",
    kind: "text-delta",
    sessionId: CANONICAL_SESSION_ID,
    text: "Bien sûr, je vais commencer par inspecter le dépôt.\n",
  },
  {
    seq: 6,
    ts: "2026-08-17T09:00:02.500Z",
    kind: "tool-call",
    sessionId: CANONICAL_SESSION_ID,
    toolCallId: "call_fixture_01",
    toolName: "bash",
    arguments: { command: "git status --short" },
  },
  {
    seq: 7,
    ts: "2026-08-17T09:00:02.600Z",
    kind: "tool-call",
    sessionId: CANONICAL_SESSION_ID,
    toolCallId: "call_fixture_01",
    toolName: "bash",
    arguments: { command: "git status --porcelain --branch", cwd: "/repo" },
    isUpdate: true,
  },
  {
    seq: 8,
    ts: "2026-08-17T09:00:03.000Z",
    kind: "tool-result",
    sessionId: CANONICAL_SESSION_ID,
    toolCallId: "call_fixture_01",
    result: {
      stdout: " M packages/runtime/src/transcript-writer.ts\n",
      stderr: "",
      exitCode: 0,
    },
    isError: false,
  },
  {
    seq: 9,
    ts: "2026-08-17T09:00:03.100Z",
    kind: "tool-call-record",
    sessionId: CANONICAL_SESSION_ID,
    tool: "bash",
    command: "git status --porcelain --branch",
    args: { command: "git status --porcelain --branch", cwd: "/repo" },
    isError: false,
    durationMs: 600,
  },
  {
    seq: 10,
    ts: "2026-08-17T09:00:03.500Z",
    kind: "permission-resolved",
    sessionId: CANONICAL_SESSION_ID,
    toolCallId: "call_fixture_01",
    decision: "allow",
    optionId: "once",
  },
  {
    seq: 11,
    ts: "2026-08-17T09:00:04.000Z",
    kind: "tool-call",
    sessionId: CANONICAL_SESSION_ID,
    toolCallId: "call_fixture_02",
    toolName: "git",
    arguments: { subcommand: "commit", args: ["-m", "chore: tidy"], create_pr: true },
  },
  {
    seq: 12,
    ts: "2026-08-17T09:00:06.000Z",
    kind: "tool-result",
    sessionId: CANONICAL_SESSION_ID,
    toolCallId: "call_fixture_02",
    result: {
      output: {
        commit: "abc1234",
        prUrl: "https://github.com/agentproto/ts/pull/123",
      },
    },
    isError: false,
  },
  {
    seq: 13,
    ts: "2026-08-17T09:00:06.100Z",
    kind: "tool-call-record",
    sessionId: CANONICAL_SESSION_ID,
    tool: "git",
    command: "git commit -m chore: tidy",
    args: { subcommand: "commit", args: ["-m", "chore: tidy"], create_pr: true },
    isError: false,
    durationMs: 2100,
    createdPrUrl: "https://github.com/agentproto/ts/pull/123",
    createdPrNumber: 123,
  },
  {
    seq: 14,
    ts: "2026-08-17T09:00:06.500Z",
    kind: "notice",
    sessionId: CANONICAL_SESSION_ID,
    text: "Démonstration de fixture : notice système (kind inconnu côté client).",
  },
  {
    seq: 15,
    ts: "2026-08-17T09:00:06.600Z",
    kind: "turn-end",
    sessionId: CANONICAL_SESSION_ID,
    reason: "turn-complete",
  },
] satisfies AgentprotoRawTranscriptRecord[]