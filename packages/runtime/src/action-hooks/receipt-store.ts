/**
 * ReactionReceiptStore: the durable receipt store for action hooks (AIP-71).
 *
 * A receipt is the durable record of one reaction attempt, keyed by the
 * AIP-71 occurrence key `<session-id>/<event>/<occurrence-id>/<binding-id>`.
 * The store is a second user of the shared durable-row mechanics: it owns its
 * own file, row shape and status vocabulary, and never reuses the Sentinel
 * webhook outbox (AIP-71 section 7).
 *
 * `pending` means durable acceptance but no started target: the `running`
 * transition is written durably before the target runs, so a persisted
 * `pending` row never started. `done` and `dead` are terminal and never leave.
 */

import { resolve, join } from "node:path"
import { homedir } from "node:os"

import { createDurableRowFile, oldestTerminalKey } from "../durable-row-file.js"
import { redactUrls } from "../webhook-egress/delivery.js"
import { buildOccurrenceKey } from "./occurrence-key.js"

// ── Types ─────────────────────────────────────────────────────────────

/** Redaction policy revision applied to every persisted error string. */
export const RECEIPT_REDACTION_REVISION = "url-v1"

export type ReactionReceiptStatus = "pending" | "running" | "done" | "failed" | "dead"

export interface ReactionReceiptKey {
  sessionId: string
  event: string
  occurrenceId: string
  bindingId: string
}

export interface ReactionReceipt {
  receiptKey: string
  sessionId: string
  event: string
  occurrenceId: string
  bindingId: string
  actionId: string
  configRevision: string
  status: ReactionReceiptStatus
  attempt: number
  maxAttempts: number
  nextAttemptAt?: number
  lastError?: string
  createdAt: number
  startedAt?: number
  lastAttemptAt?: number
  completedAt?: number
  causedByEventId?: string
  reactionDepth: number
  outcomeRef?: string
  redaction: string
}

export type NewReactionReceipt = Omit<
  ReactionReceipt,
  "status" | "attempt" | "createdAt" | "redaction" | "receiptKey"
> & { createdAt?: number }

export type ReceiptTransitionCode = "not_found" | "terminal" | "already_running" | "not_running"

export class ReceiptTransitionError extends Error {
  readonly code: ReceiptTransitionCode
  readonly receiptKey: string

  constructor(code: ReceiptTransitionCode, receiptKey: string) {
    super(`Reaction receipt ${receiptKey}: ${code}`)
    this.name = "ReceiptTransitionError"
    this.code = code
    this.receiptKey = receiptKey
  }
}

export interface ReactionReceiptStore {
  readonly path: string
  /** A shallow copy, never the live row. */
  get(key: string): ReactionReceipt | undefined
  /** Shallow copies. */
  rows(): ReactionReceipt[]
  insertPending(input: NewReactionReceipt): Promise<ReactionReceipt>
  markRunning(key: string, opts?: { redrive?: boolean }): Promise<void>
  markDone(key: string, outcomeRef: string | undefined): Promise<void>
  markFailed(key: string, error: string, nextAttemptAt: number | undefined): Promise<void>
  markDead(key: string, reason: string): Promise<void>
  sweep(): void
  flushSync(): void
}

export interface ReactionReceiptStoreOptions {
  /** Default `~/.agentproto/reaction-receipts.json`. */
  filePath?: string
  /** Injectable clock. Every timestamp comes from it. Default `Date.now`. */
  nowMs?: () => number
  /** Debounce interval for the non-critical transitions. Default 1500 ms. */
  debounceMs?: number
  /** Disable disk persistence. Default true. */
  persist?: boolean
  /** Default `console.warn`. */
  log?: (line: string) => void
  /** `done` rows are reaped after this. Default 24 h. */
  doneReapMs?: number
  /** Pending/running/failed rows age out after this. Default 7 d. */
  nonTerminalAgeOutMs?: number
  /** The oldest terminal row is evicted beyond this. Default 2000. */
  rowCap?: number
}

// ── Constants ─────────────────────────────────────────────────────────

const LOG_PREFIX = "[reaction-receipts]"

function agentprotoHome(): string {
  return process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
}

const PERSIST_DEBOUNCE_MS = 1_500

const DONE_REAP_MS = 24 * 60 * 60 * 1000

const NON_TERMINAL_AGE_OUT_MS = 7 * 24 * 60 * 60 * 1000

const ROW_CAP = 2_000

const STATUSES: readonly ReactionReceiptStatus[] = ["pending", "running", "done", "failed", "dead"]

const FINITE_NUMBER_FIELDS = ["attempt", "maxAttempts", "createdAt", "reactionDepth"] as const

const OPTIONAL_FINITE_NUMBER_FIELDS = [
  "startedAt",
  "lastAttemptAt",
  "completedAt",
  "nextAttemptAt",
] as const

const OPTIONAL_STRING_FIELDS = ["lastError", "outcomeRef", "causedByEventId"] as const

const STRING_FIELDS = [
  "receiptKey",
  "sessionId",
  "event",
  "occurrenceId",
  "bindingId",
  "actionId",
  "configRevision",
  "redaction",
] as const

// ── Key ───────────────────────────────────────────────────────────────

/** Delegate to the AIP-71 occurrence key builder (throws on a bad segment). */
export function buildReactionReceiptKey(key: ReactionReceiptKey): string {
  return buildOccurrenceKey(key)
}

// ── Factory ───────────────────────────────────────────────────────────

export function createReactionReceiptStore(opts: ReactionReceiptStoreOptions = {}): ReactionReceiptStore {
  const filePath = opts.filePath ?? resolve(agentprotoHome(), "reaction-receipts.json")
  const nowMs = opts.nowMs ?? Date.now
  const debounceMs = opts.debounceMs ?? PERSIST_DEBOUNCE_MS
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const persist = opts.persist ?? true
  const doneReapMs = opts.doneReapMs ?? DONE_REAP_MS
  const nonTerminalAgeOutMs = opts.nonTerminalAgeOutMs ?? NON_TERMINAL_AGE_OUT_MS
  const rowCap = opts.rowCap ?? ROW_CAP

  const acceptLoaded = (value: unknown): readonly [string, ReactionReceipt] | undefined => {
    const drop = (reason: string): undefined => {
      log(`${LOG_PREFIX} dropped invalid row: ${reason}`)
      return undefined
    }
    if (typeof value !== "object" || value === null) return drop("not an object")
    const row = value as Partial<ReactionReceipt>
    for (const field of STRING_FIELDS) {
      if (typeof row[field] !== "string") return drop(`${field} is not a string`)
    }
    if (!STATUSES.includes(row.status as ReactionReceiptStatus)) return drop("status is invalid")
    for (const field of FINITE_NUMBER_FIELDS) {
      if (typeof row[field] !== "number" || !Number.isFinite(row[field])) {
        return drop(`${field} is not a finite number`)
      }
    }
    for (const field of OPTIONAL_FINITE_NUMBER_FIELDS) {
      const value = row[field]
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        return drop(`${field} is not a finite number`)
      }
    }
    for (const field of OPTIONAL_STRING_FIELDS) {
      const value = row[field]
      if (value !== undefined && typeof value !== "string") {
        return drop(`${field} is not a string`)
      }
    }
    const receipt = row as ReactionReceipt
    let key: string
    try {
      key = buildReactionReceiptKey({
        sessionId: receipt.sessionId,
        event: receipt.event,
        occurrenceId: receipt.occurrenceId,
        bindingId: receipt.bindingId,
      })
    } catch (err) {
      return drop(err instanceof Error ? err.message : String(err))
    }
    // Never trust a stored key: it must equal the key rebuilt from its parts.
    if (receipt.receiptKey !== key) return drop("receiptKey does not match its parts")
    return [key, receipt]
  }

  const durable = createDurableRowFile<ReactionReceipt>({
    filePath,
    persist,
    debounceMs,
    log,
    logPrefix: LOG_PREFIX,
    acceptLoaded,
  })

  const rows = durable.rows

  const copy = (row: ReactionReceipt): ReactionReceipt => ({ ...row })

  const oldestTerminalRowKey = (): string | undefined =>
    oldestTerminalKey(
      rows,
      row => row.status === "done" || row.status === "dead",
      row => row.completedAt ?? row.createdAt,
    )

  const present = (key: string): ReactionReceipt => {
    const row = rows.get(key)
    if (!row) throw new ReceiptTransitionError("not_found", key)
    return row
  }

  const assertMutable = (row: ReactionReceipt, key: string): void => {
    if (row.status === "done" || row.status === "dead") {
      throw new ReceiptTransitionError("terminal", key)
    }
  }

  const sweep = (): void => {
    const now = nowMs()
    let changed = false
    for (const [key, row] of rows.entries()) {
      if (row.status === "done") {
        if (row.completedAt !== undefined && now - row.completedAt >= doneReapMs) {
          rows.delete(key)
          changed = true
        }
        continue
      }
      if (row.status !== "pending" && row.status !== "running" && row.status !== "failed") continue
      if (now - row.createdAt >= nonTerminalAgeOutMs) {
        row.status = "dead"
        row.lastError = "age_out"
        row.completedAt = now
        delete row.nextAttemptAt
        changed = true
      }
    }
    while (rows.size > rowCap) {
      const oldest = oldestTerminalRowKey()
      if (!oldest) break
      rows.delete(oldest)
      changed = true
    }
    if (changed) durable.schedulePersist()
  }

  return {
    path: filePath,

    get(key: string): ReactionReceipt | undefined {
      const row = rows.get(key)
      return row ? copy(row) : undefined
    },

    rows(): ReactionReceipt[] {
      return Array.from(rows.values(), copy)
    },

    async insertPending(input: NewReactionReceipt): Promise<ReactionReceipt> {
      const key = buildReactionReceiptKey(input)
      if (input.createdAt !== undefined && !Number.isFinite(input.createdAt)) {
        throw new Error(`reaction receipt ${key}: createdAt is not a finite number`)
      }
      const existing = rows.get(key)
      if (existing) {
        // Dedupe: a duplicate never creates a second row and never resets a
        // row's status. A pending duplicate may be an in-flight insert whose
        // write has not landed, so wait for it before returning.
        await durable.settled()
        if (rows.get(key) !== existing) {
          throw new Error(`reaction receipt ${key} was not persisted`)
        }
        return copy(existing)
      }

      const row: ReactionReceipt = {
        receiptKey: key,
        sessionId: input.sessionId,
        event: input.event,
        occurrenceId: input.occurrenceId,
        bindingId: input.bindingId,
        actionId: input.actionId,
        configRevision: input.configRevision,
        status: "pending",
        attempt: 0,
        maxAttempts: input.maxAttempts,
        createdAt: input.createdAt ?? nowMs(),
        reactionDepth: input.reactionDepth,
        redaction: RECEIPT_REDACTION_REVISION,
        ...(input.causedByEventId !== undefined ? { causedByEventId: input.causedByEventId } : {}),
      }

      await durable.insertDurable(key, row, { cap: rowCap, oldestTerminalKey: oldestTerminalRowKey })
      return copy(row)
    },

    async markRunning(key: string, opts?: { redrive?: boolean }): Promise<void> {
      const row = present(key)
      if (row.status === "running") {
        if (!opts?.redrive) throw new ReceiptTransitionError("already_running", key)
      } else {
        assertMutable(row, key)
      }

      // The check and the mutation are synchronous, before any await, so two
      // concurrent callers cannot both win (single-flight).
      const previous = {
        status: row.status,
        attempt: row.attempt,
        startedAt: row.startedAt,
        nextAttemptAt: row.nextAttemptAt,
      }
      row.status = "running"
      row.attempt += 1
      row.startedAt = nowMs()
      delete row.nextAttemptAt

      try {
        // Durable: a persisted `pending` row must mean "never started".
        await durable.persistNow()
      } catch (err) {
        row.status = previous.status
        row.attempt = previous.attempt
        if (previous.startedAt === undefined) delete row.startedAt
        else row.startedAt = previous.startedAt
        if (previous.nextAttemptAt === undefined) delete row.nextAttemptAt
        else row.nextAttemptAt = previous.nextAttemptAt
        throw err
      }
    },

    async markDone(key: string, outcomeRef: string | undefined): Promise<void> {
      const row = present(key)
      if (row.status !== "running") {
        assertMutable(row, key)
        throw new ReceiptTransitionError("not_running", key)
      }
      row.status = "done"
      row.completedAt = nowMs()
      if (outcomeRef !== undefined) row.outcomeRef = outcomeRef
      delete row.nextAttemptAt
      delete row.lastError
      delete row.lastAttemptAt
      // Debounced: a lost `done` is recovered by a re-drive of the running row.
      durable.schedulePersist()
    },

    async markFailed(key: string, error: string, nextAttemptAt: number | undefined): Promise<void> {
      const row = present(key)
      if (row.status !== "running") {
        assertMutable(row, key)
        throw new ReceiptTransitionError("not_running", key)
      }
      const redacted = redactUrls(error)
      if (row.attempt >= row.maxAttempts) {
        // Exhaustion is terminal and must not replay: persist durably.
        const previous = {
          status: row.status,
          lastError: row.lastError,
          completedAt: row.completedAt,
          nextAttemptAt: row.nextAttemptAt,
        }
        row.status = "dead"
        row.lastError = redacted
        row.completedAt = nowMs()
        delete row.nextAttemptAt
        try {
          await durable.persistNow()
        } catch (err) {
          row.status = previous.status
          if (previous.lastError === undefined) delete row.lastError
          else row.lastError = previous.lastError
          if (previous.completedAt === undefined) delete row.completedAt
          else row.completedAt = previous.completedAt
          if (previous.nextAttemptAt === undefined) delete row.nextAttemptAt
          else row.nextAttemptAt = previous.nextAttemptAt
          throw err
        }
        return
      }
      row.status = "failed"
      row.lastError = redacted
      row.lastAttemptAt = nowMs()
      if (nextAttemptAt === undefined) delete row.nextAttemptAt
      else row.nextAttemptAt = nextAttemptAt
      durable.schedulePersist()
    },

    async markDead(key: string, reason: string): Promise<void> {
      const row = present(key)
      if (row.status === "dead") return
      if (row.status === "done") throw new ReceiptTransitionError("terminal", key)
      const previous = {
        status: row.status,
        lastError: row.lastError,
        completedAt: row.completedAt,
        nextAttemptAt: row.nextAttemptAt,
      }
      row.status = "dead"
      row.lastError = redactUrls(reason)
      row.completedAt = nowMs()
      delete row.nextAttemptAt
      // Rare and terminal: a lost dead must not replay a non-retryable or
      // recursion-capped reaction.
      try {
        await durable.persistNow()
      } catch (err) {
        row.status = previous.status
        if (previous.lastError === undefined) delete row.lastError
        else row.lastError = previous.lastError
        if (previous.completedAt === undefined) delete row.completedAt
        else row.completedAt = previous.completedAt
        if (previous.nextAttemptAt === undefined) delete row.nextAttemptAt
        else row.nextAttemptAt = previous.nextAttemptAt
        throw err
      }
    },

    sweep,

    flushSync: durable.flushSync,
  }
}
