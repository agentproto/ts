/**
 * The approvals engine — the daemon's human-approval primitive (AIP-7
 * signatures as the mechanism). See `.plans/pygmalion/lanes/E1a.md`.
 *
 * Every mutation here is atomic in the sense the Pygmalion M1 gate uses the
 * word: the status check + in-memory mutation + sync persistence happen
 * with NO `await` between them, so a second concurrent call always
 * observes the first call's write. The AIP-7 signature write
 * (`signArtifact`) and its audit event are async and run AFTER that
 * synchronous transition — a decide can never race itself, only the
 * signature can arrive slightly after the status flip a `wait()` caller
 * already observed pending→approved.
 *
 * Nothing exported here can decide, mint a ticket, or sign — `decideWeb`
 * is reachable only from the HTTP route `POST /approvals/:id/decision`,
 * `mintCardTicket`/`decideByCard` only from the card resource's HTML /
 * the `approval_card_decide` tool. The MCP tools facing an agent
 * (`approvals/tools.ts`) expose only `request` / `get` / `wait` / `consume`.
 *
 * No task-board coupling here — that lands in a later lane (E1b). A
 * request's `taskId` is recorded verbatim and rides the `approval:*`
 * events for a future subscriber; this engine never reads or writes a
 * task ledger.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

import { recordAuditEvent, signArtifact } from "@agentproto/governance-engine"

import type { SessionEventBus } from "../session-event-bus.js"
import { canonicalPayloadFor, payloadSha256, sha256Hex } from "./canonical.js"
import { resolveApprovalsGovernanceConfig } from "./governance.js"
import {
  defaultApprovalsHomeDir,
  loadAllApprovals,
  loadAllCardTickets,
  payloadRelativePath,
  readCardTicket,
  writeApprovalRecord,
  writeCardTicket,
  writePayload,
} from "./store.js"
import {
  APPROVAL_CHANNELS,
  CARD_TICKET_TTL_MS,
  ApprovalError,
  ApprovalNotPendingError,
  CardTicketError,
  type ApprovalChannel,
  type ApprovalDecision,
  type ApprovalRecord,
  type ApprovalRequester,
  type ApprovalStatus,
  type CardTicketErrorCode,
  type CardTicketRecord,
} from "./types.js"

export interface ApprovalRequestInput {
  kind: string
  title: string
  preview: unknown
  payload: unknown
  taskId?: string
  appId?: string
  /** Restrict to a subset of the enabled channels. Omit for "every
   *  channel this daemon has enabled" (see {@link ApprovalsEngineOptions.webOrigins}). */
  channels?: readonly ApprovalChannel[]
  expiresAt?: string
}

export interface ApprovalsEngineOptions {
  /** Root dir for persisted approvals. Defaults to `~/.agentproto/approvals`;
   *  tests pass a tmp dir. */
  homeDir?: string
  sessionEvents: SessionEventBus
  /** Origins allowed to decide through the `web_click` channel
   *  (`approvals.webOrigins`). Empty/absent ⇒ `web_click` is OFF — every
   *  new request's `channels` omits it, and the HTTP decision route always
   *  403s. `ui_card` has no such gate (its own ticket IS the credential). */
  webOrigins?: readonly string[]
}

/** Same requester? Used by `consume`'s `not_requester` check — the
 *  operator may consume anything an operator-made request produced;
 *  a session may only consume its own. */
function sameRequester(a: ApprovalRequester, b: ApprovalRequester): boolean {
  if ("sessionId" in a && "sessionId" in b) return a.sessionId === b.sessionId
  return "operator" in a && "operator" in b
}

export interface ApprovalListFilter {
  status?: ApprovalStatus
}

export interface ApprovalDecideEvidence {
  ipAddress: string
  userAgent: string
}

export interface ApprovalsEngine {
  enabledChannels: readonly ApprovalChannel[]
  request(input: ApprovalRequestInput, requester: ApprovalRequester): ApprovalRecord
  get(id: string): ApprovalRecord | undefined
  list(filter?: ApprovalListFilter): ApprovalRecord[]
  /** Resolves once the approval leaves `pending` (approved/denied/expired),
   *  or after `timeoutMs` with whatever the current record is (still
   *  pending, most likely). Resolves immediately if already decided. */
  wait(id: string, timeoutMs: number): Promise<ApprovalRecord | undefined>
  decideWeb(id: string, decision: ApprovalDecision, evidence: ApprovalDecideEvidence): Promise<ApprovalRecord>
  mintCardTicket(id: string): { ticket: string; expiresAt: string }
  decideByCard(
    id: string,
    decision: ApprovalDecision,
    ticket: string,
    evidence: ApprovalDecideEvidence,
  ): Promise<ApprovalRecord>
  consume(id: string, requester: ApprovalRequester, payload: unknown): ApprovalRecord
  dispose(): void
}

export function createApprovalsEngine(opts: ApprovalsEngineOptions): ApprovalsEngine {
  const homeDir = opts.homeDir ?? defaultApprovalsHomeDir()
  const { sessionEvents } = opts
  const webOrigins = opts.webOrigins ?? []
  const enabledChannels: ApprovalChannel[] = webOrigins.length > 0 ? ["web_click", "ui_card"] : ["ui_card"]

  const approvals = loadAllApprovals(homeDir)
  const cardTickets = loadAllCardTickets(homeDir)
  const waiters = new Map<string, Array<(record: ApprovalRecord) => void>>()

  const notifyWaiters = (record: ApprovalRecord): void => {
    const list = waiters.get(record.id)
    if (!list) return
    waiters.delete(record.id)
    for (const resolve of list) resolve(record)
  }

  const emit = (
    type: "approval:requested" | "approval:decided" | "approval:consumed" | "approval:expired",
    record: ApprovalRecord,
  ): void => {
    const ts = new Date().toISOString()
    const base = { approvalId: record.id, ...(record.taskId ? { taskId: record.taskId } : {}), ts }
    if (type === "approval:requested") {
      sessionEvents.emit({ type, kind: record.kind, ...base })
    } else if (type === "approval:decided") {
      const decision = record.decision
      if (!decision) return
      sessionEvents.emit({
        type,
        decision: decision.decision,
        channel: decision.channel,
        ...base,
      })
    } else {
      sessionEvents.emit({ type, ...base })
    }
  }

  /** Lazy expiry: a `pending` record whose `expiresAt` has passed flips to
   *  `expired` the next time anything looks at it — no background timer.
   *  Called at the top of every read/mutate entry point. */
  const checkExpiry = (record: ApprovalRecord): ApprovalRecord => {
    if (record.status !== "pending") return record
    if (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()) return record
    const expired: ApprovalRecord = { ...record, status: "expired" }
    approvals.set(record.id, expired)
    writeApprovalRecord(homeDir, expired)
    emit("approval:expired", expired)
    notifyWaiters(expired)
    return expired
  }

  const liveGet = (id: string): ApprovalRecord | undefined => {
    const record = approvals.get(id)
    return record ? checkExpiry(record) : undefined
  }

  const request = (input: ApprovalRequestInput, requester: ApprovalRequester): ApprovalRecord => {
    const id = `apr_${randomUUID().replace(/-/g, "").slice(0, 20)}`
    const requestedChannels =
      input.channels && input.channels.length > 0
        ? input.channels.filter(c => enabledChannels.includes(c))
        : enabledChannels
    const canonicalJson = canonicalPayloadFor(input.payload)
    const payloadHash = sha256Hex(canonicalJson)
    const now = new Date().toISOString()

    const record: ApprovalRecord = {
      id,
      kind: input.kind,
      title: input.title,
      preview: input.preview,
      payloadHash,
      status: "pending",
      requestedBy: requester,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.appId ? { appId: input.appId } : {}),
      channels: requestedChannels,
      requestedAt: now,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    }
    writePayload(homeDir, id, canonicalJson)
    writeApprovalRecord(homeDir, record)
    approvals.set(id, record)
    emit("approval:requested", record)
    return record
  }

  const get = (id: string): ApprovalRecord | undefined => liveGet(id)

  const list = (filter?: ApprovalListFilter): ApprovalRecord[] => {
    const all = Array.from(approvals.keys()).map(id => liveGet(id)!)
    if (!filter?.status) return all
    return all.filter(a => a.status === filter.status)
  }

  const wait = (id: string, timeoutMs: number): Promise<ApprovalRecord | undefined> => {
    const current = liveGet(id)
    if (!current) return Promise.resolve(undefined)
    if (current.status !== "pending") return Promise.resolve(current)
    return new Promise(resolve => {
      const list = waiters.get(id) ?? []
      list.push(resolve)
      waiters.set(id, list)
      const timer = setTimeout(() => {
        const list2 = waiters.get(id)
        if (!list2) return
        const idx = list2.indexOf(resolve)
        if (idx >= 0) list2.splice(idx, 1)
        if (list2.length === 0) waiters.delete(id)
        resolve(liveGet(id))
      }, timeoutMs)
      timer.unref?.()
    })
  }

  /** The synchronous half of a decide: validate + mutate + persist, with
   *  NO await in this function — see the module doc. Returns the mutated
   *  record (decision.signaturePath still absent for an approve; the
   *  async caller patches it in after `signArtifact` resolves). */
  const decideCore = (id: string, decision: ApprovalDecision, channel: ApprovalChannel): ApprovalRecord => {
    const existing = liveGet(id)
    if (!existing) throw new ApprovalError("approval_not_found", `no approval ${id}`)
    if (existing.status !== "pending") throw new ApprovalNotPendingError(existing.status)
    if (!existing.channels.includes(channel)) {
      throw new Error(`approval ${id}: channel "${channel}" is not allowed for this approval`)
    }
    const record: ApprovalRecord = {
      ...existing,
      status: decision === "approve" ? "approved" : "denied",
      decision: {
        decision: decision === "approve" ? "approved" : "denied",
        channel,
        decidedAt: new Date().toISOString(),
      },
    }
    approvals.set(id, record)
    writeApprovalRecord(homeDir, record)
    return record
  }

  /** After `decideCore`: approve → AIP-7 `signArtifact` on the pinned
   *  payload; deny → a bare audit event. Either way, patch the persisted
   *  record with `decision.signaturePath` (approve only), emit
   *  `approval:decided`, and resolve any `wait()` callers. */
  const finishDecide = async (
    record: ApprovalRecord,
    evidence: ApprovalDecideEvidence,
    signedUrlToken: string,
  ): Promise<ApprovalRecord> => {
    const config = resolveApprovalsGovernanceConfig(homeDir)
    let final = record
    if (record.decision?.decision === "approved") {
      const result = await signArtifact(config, {
        artifactPath: payloadRelativePath(record.id),
        signer: "user:local",
        signerKind: "user",
        method: "click_through",
        evidence: {
          kind: "click_through",
          ipAddress: evidence.ipAddress,
          userAgent: evidence.userAgent,
          signedUrlToken,
        },
      })
      final = {
        ...record,
        decision: { ...record.decision, signaturePath: result.signaturePath },
      }
    } else {
      await recordAuditEvent(config, {
        actorKind: "user",
        actorId: "local",
        entityType: "approval",
        entityId: payloadRelativePath(record.id),
        action: "approval.denied",
        payload: { approvalId: record.id, channel: record.decision?.channel },
      })
    }
    approvals.set(final.id, final)
    writeApprovalRecord(homeDir, final)
    emit("approval:decided", final)
    notifyWaiters(final)
    return final
  }

  const decideWeb = async (
    id: string,
    decision: ApprovalDecision,
    evidence: ApprovalDecideEvidence,
  ): Promise<ApprovalRecord> => {
    const record = decideCore(id, decision, "web_click")
    return finishDecide(record, evidence, randomBytes(16).toString("hex"))
  }

  const mintCardTicket = (id: string): { ticket: string; expiresAt: string } => {
    const existing = liveGet(id)
    if (!existing) throw new ApprovalError("approval_not_found", `no approval ${id}`)
    if (existing.status !== "pending") throw new ApprovalNotPendingError(existing.status)
    const ticket = randomBytes(32).toString("base64url")
    const expiresAt = new Date(Date.now() + CARD_TICKET_TTL_MS).toISOString()
    const record: CardTicketRecord = { approvalId: id, ticketHash: sha256Hex(ticket), expiresAt }
    cardTickets.set(id, record)
    writeCardTicket(homeDir, record)
    return { ticket, expiresAt }
  }

  const decideByCard = async (
    id: string,
    decision: ApprovalDecision,
    ticket: string,
    evidence: ApprovalDecideEvidence,
  ): Promise<ApprovalRecord> => {
    const before = cardTickets.get(id) ?? readCardTicket(homeDir, id)
    const nowMs = Date.now()
    const notExpired = before !== undefined && Date.parse(before.expiresAt) > nowMs
    const matches = before !== undefined && constantTimeEqualHex(sha256Hex(ticket), before.ticketHash)
    const valid = before !== undefined && !before.usedAt && notExpired && matches

    // Burned on any attempt (valid or not), synchronously, before anything
    // async runs — a wrong guess kills the real ticket too.
    if (before && !before.usedAt) {
      const burned: CardTicketRecord = { ...before, usedAt: new Date().toISOString() }
      cardTickets.set(id, burned)
      writeCardTicket(homeDir, burned)
    }

    if (!valid) {
      const code: CardTicketErrorCode = !before
        ? "missing"
        : before.usedAt
          ? "used"
          : !notExpired
            ? "expired"
            : "mismatch"
      throw new CardTicketError(code, `card ticket ${code} for approval ${id}`)
    }

    const record = decideCore(id, decision, "ui_card")
    return finishDecide(record, evidence, before!.ticketHash)
  }

  const consume = (id: string, requester: ApprovalRequester, payload: unknown): ApprovalRecord => {
    const existing = liveGet(id)
    if (!existing) throw new ApprovalError("approval_not_found", `no approval ${id}`)
    if (!sameRequester(existing.requestedBy, requester)) {
      throw new ApprovalError("not_requester", `approval ${id} was not requested by this caller`)
    }
    if (existing.status === "consumed") {
      throw new ApprovalError("approval_already_consumed", `approval ${id} was already consumed`)
    }
    if (existing.status === "expired") {
      throw new ApprovalError("approval_expired", `approval ${id} expired before it was consumed`)
    }
    if (existing.status !== "approved") {
      throw new ApprovalError("approval_not_approved", `approval ${id} is not approved`)
    }
    if (payloadSha256(payload) !== existing.payloadHash) {
      throw new ApprovalError("payload_mismatch", "payload does not match the approved payload")
    }
    const record: ApprovalRecord = { ...existing, status: "consumed", consumedAt: new Date().toISOString() }
    approvals.set(id, record)
    writeApprovalRecord(homeDir, record)
    emit("approval:consumed", record)
    return record
  }

  return {
    enabledChannels,
    request,
    get,
    list,
    wait,
    decideWeb,
    mintCardTicket,
    decideByCard,
    consume,
    dispose(): void {
      waiters.clear()
    },
  }
}

/** Constant-time compare of two equal-length hex digests (mirrors
 *  `join-token-registry.ts`'s `constantTimeEqual`): HMAC both sides under a
 *  fresh random key first so `timingSafeEqual` always compares two 32-byte
 *  buffers regardless of the inputs' own lengths. */
function constantTimeEqualHex(a: string, b: string): boolean {
  const key = randomBytes(32)
  const da = createHmac("sha256", key).update(a, "utf8").digest()
  const db = createHmac("sha256", key).update(b, "utf8").digest()
  return timingSafeEqual(da, db)
}

export { APPROVAL_CHANNELS }
