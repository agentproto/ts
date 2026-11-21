/**
 * Parent to child allocation (AIP-BILLING `transfers`, AIP-49 transfer).
 *
 * Two journals are touched, the parent's (a `transfer` leg out of the lot) and
 * the child's (a `mint` carrying the origin lot's expiry, `expiry: inherit`).
 * `StoragePort.commit` is per account, so the two commits are not one atomic
 * step: the parent leg goes first and both carry deterministic ids, so a retry
 * finishes what a crash left half done: the destination leg is rebuilt from
 * the recorded `out` events and committed before the replay is answered.
 */
import { fold, type Lot } from "@agentproto/wallet"
import { serial } from "./payment.js"
import type { BillingDeps, CauseEvent } from "./ports.js"

export interface TransferRequest {
  kind: "allocate" | "reclaim"
  /** Idempotency reference, also the cause of the entries. */
  ref: string
  parentId: string
  childId: string
  amount: number
  at?: number
}

export async function applyTransfer(deps: BillingDeps, req: TransferRequest): Promise<{ moved: number; status: "applied" | "replayed" | "refused"; reason?: string }> {
  const t = deps.manifest.transfers
  if (!t || !t.allow.includes(req.kind)) return { moved: 0, status: "refused", reason: `transfer '${req.kind}' is not allowed` }
  return serial(`transfer:${req.ref}`, async () => {
    const now = req.at ?? deps.clock.nowMs()
    const [src, dst] = req.kind === "allocate" ? [req.parentId, req.childId] : [req.childId, req.parentId]
    const outId = (lotId: string) => `${req.ref}:out:${lotId}`
    const srcEvents = (await deps.storage.loadEvents(src)) as CauseEvent[]
    const done = srcEvents.filter(e => e.id.startsWith(`${req.ref}:out:`))
    if (done.length > 0) {
      // Replay after a crash between the two commits: the source leg is in, the
      // destination leg may not be. Rebuild it from the recorded outs (deterministic
      // ids) and commit what is missing, so no value leaves the parent journal unminted.
      const dstEvents = (await deps.storage.loadEvents(dst)) as CauseEvent[]
      const haveIn = new Set(dstEvents.map(e => e.id))
      const srcLots = new Map(fold(srcEvents, now).map(l => [l.id, l]))
      const missing: CauseEvent[] = []
      for (const o of done) {
        const inId = `${req.ref}:in:${o.lotId}`
        if (haveIn.has(inId)) continue
        const srcLot = srcLots.get(o.lotId)
        missing.push({
          id: inId,
          accountId: dst,
          kind: "mint",
          asset: o.asset,
          partitionId: o.partitionId,
          restriction: o.restriction,
          amount: o.amount,
          lotId: inId,
          ...(srcLot?.expiresAt !== undefined ? { expiresAt: srcLot.expiresAt } : {}),
          occurredAt: o.occurredAt,
          cause: req.ref,
          origin: o.origin,
        })
      }
      if (missing.length > 0) await deps.storage.commit(dst, missing)
      return { moved: 0, status: "replayed" as const }
    }
    const allowed = new Set(t.from ?? [])
    const lots: Lot[] = fold(srcEvents, now)
      .filter(l => l.asset === deps.manifest.primaryAsset && (allowed.size === 0 || allowed.has(l.partitionId)))
      .filter(l => !(l.expiresAt !== undefined && l.expiresAt <= now) && l.remaining - l.reserved > 0)
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.createdAt - b.createdAt)
    let need = req.amount
    const out: CauseEvent[] = []
    const into: CauseEvent[] = []
    for (const l of lots) {
      if (need <= 0) break
      const take = Math.min(need, l.remaining - l.reserved)
      out.push({ id: outId(l.id), accountId: src, kind: "transfer", asset: l.asset, partitionId: l.partitionId, restriction: l.restriction, amount: take, lotId: l.id, occurredAt: now, cause: req.ref, origin: req.kind })
      into.push({ id: `${req.ref}:in:${l.id}`, accountId: dst, kind: "mint", asset: l.asset, partitionId: l.partitionId, restriction: l.restriction, amount: take, lotId: `${req.ref}:in:${l.id}`, ...(l.expiresAt !== undefined ? { expiresAt: l.expiresAt } : {}), occurredAt: now, cause: req.ref, origin: req.kind })
      need -= take
    }
    if (need > 0) return { moved: 0, status: "refused" as const, reason: `only ${req.amount - need} available` }
    await deps.storage.commit(src, out)
    await deps.storage.commit(dst, into)
    return { moved: req.amount, status: "applied" as const }
  })
}
