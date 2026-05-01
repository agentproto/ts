import * as path from "node:path"

import {
  auditEventSchema,
  type ActorKind,
  type AuditEvent,
} from "@agentproto/governance/doctypes"
import { chainRow } from "@agentproto/governance/hash-chain"
import { getFilesystem, resolveFromRoot } from "./fs.js"
import { withPathLock } from "./path-lock.js"
import {
  type GovernanceConfig,
  type AnchorPayload,
  DEFAULT_ANCHOR_EVERY_LINES,
} from "./workspace-config.js"

/**
 * `recordAuditEvent` — append a hash-chained audit event to the workspace's
 * audit log.
 *
 * Scope is workspace-relative; defaults to the workspace-level log
 * (`audit/audit-log.jsonl`). Per-engagement scope is the typical alternative
 * (`engagements/<slug>/audit/audit-log.jsonl`).
 *
 * The function:
 *   1. Reads the current log to find the last signature (or uses genesisSeed for the first line).
 *   2. Composes the row, computes the chain signature.
 *   3. Appends the JSONL line.
 *   4. Optionally invokes the anchor sink if the line index crosses the cadence.
 *
 * Returns the recorded event with `prevSignature` and `signature` populated.
 */

export interface RecordAuditEventInput {
  /**
   * Where the log lives. Workspace-relative folder; the file is
   * `<scope>/audit-log.jsonl`. Default: `audit` (workspace-level log).
   *
   * Example for engagement-scoped: `engagements/2026-acme/audit`
   */
  scopeDir?: string

  actorKind: ActorKind
  actorId: string | null

  entityType: string
  entityId: string
  /** "<entity>.<verb>" lowercase (e.g., `signature.created`). */
  action: string

  payload?: Record<string, unknown>
  requestId?: string
  traceId?: string
  ipAddress?: string
  userAgent?: string

  /**
   * Idempotency key. v1 stores it in `metadata.idempotencyKey` for inspection
   * but does not yet dedup automatically (TODO: `_index/dispatched-keys.json`).
   */
  idempotencyKey?: string

  /** Override the timestamp; default is `new Date().toISOString()`. */
  createdAt?: string

  /** Vendor extensions under metadata.<vendor>.* */
  metadata?: Record<string, unknown>
}

export interface RecordAuditEventResult {
  event: AuditEvent
  /** Workspace-relative path to the log file. */
  logPath: string
  /** 0-based line index of the appended event. */
  lineIndex: number
  /** True if an anchor was emitted on this append. */
  anchored: boolean
}

const SCOPE_DIR_DEFAULT = "audit"

export async function recordAuditEvent(
  config: GovernanceConfig,
  input: RecordAuditEventInput
): Promise<RecordAuditEventResult> {
  const fs = getFilesystem(config)
  const scopeDir = input.scopeDir ?? SCOPE_DIR_DEFAULT
  const logRel = `${scopeDir}/audit-log.jsonl`
  const logAbs = resolveFromRoot(config.workspaceRoot, logRel)

  // Serialize the read-tail → compute-chain → append sequence per log path.
  // Without this lock, concurrent appends silently corrupt the chain.
  return withPathLock(logAbs, () =>
    recordAuditEventLocked(config, input, logRel, logAbs)
  )
}

async function recordAuditEventLocked(
  config: GovernanceConfig,
  input: RecordAuditEventInput,
  logRel: string,
  logAbs: string
): Promise<RecordAuditEventResult> {
  const fs = getFilesystem(config)

  const existing = await fs.readFile(logAbs)
  const lines =
    existing == null
      ? []
      : existing
          .split("\n")
          .map(l => l.trim())
          .filter(l => l.length > 0)

  let prevSignature = config.genesisSeed
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1]!
    const last = JSON.parse(lastLine) as { signature?: string }
    if (typeof last.signature !== "string") {
      throw new Error(
        `recordAuditEvent: tail of ${logRel} is missing a signature field — chain corrupted`
      )
    }
    prevSignature = last.signature
  }

  const createdAt = input.createdAt ?? new Date().toISOString()
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) }
  if (input.idempotencyKey) metadata.idempotencyKey = input.idempotencyKey

  const rowWithoutChain: Record<string, unknown> = {
    schema: "agentgovernance/v1",
    doctype: "audit-event",
    actorKind: input.actorKind,
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    createdAt,
  }
  if (input.payload !== undefined) rowWithoutChain.payload = input.payload
  if (input.requestId !== undefined) rowWithoutChain.requestId = input.requestId
  if (input.traceId !== undefined) rowWithoutChain.traceId = input.traceId
  if (input.ipAddress !== undefined) rowWithoutChain.ipAddress = input.ipAddress
  if (input.userAgent !== undefined) rowWithoutChain.userAgent = input.userAgent
  if (Object.keys(metadata).length > 0) rowWithoutChain.metadata = metadata

  const chained = chainRow(rowWithoutChain, prevSignature, config.hmacSecret)

  // Validate against zod before writing — catch any shape regression early.
  const parsed = auditEventSchema.safeParse(chained)
  if (!parsed.success) {
    throw new Error(
      `recordAuditEvent: produced an invalid event — ${parsed.error.issues.map(i => i.message).join("; ")}`
    )
  }

  await fs.ensureDir(path.dirname(logAbs))
  await fs.appendLine(logAbs, JSON.stringify(chained))

  const lineIndex = lines.length
  const anchorEvery = config.anchorEveryLines ?? DEFAULT_ANCHOR_EVERY_LINES
  const anchored = (lineIndex + 1) % anchorEvery === 0
  if (anchored && config.anchorSink) {
    const anchor: AnchorPayload = {
      logPath: logRel,
      lineIndex,
      signature: chained.signature,
      emittedAt: new Date().toISOString(),
    }
    await config.anchorSink(anchor)
  }

  return {
    event: parsed.data,
    logPath: logRel,
    lineIndex,
    anchored,
  }
}
