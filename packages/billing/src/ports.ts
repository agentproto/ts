/**
 * Ports of the payment path. The journal itself is the AIP-49 `StoragePort`
 * and `ClockPort`; this file adds only what is NOT money: the state of a paid
 * subscription period and of a one-time access.
 */
import type { WalletEvent } from "@agentproto/wallet"
import type { ClockPort, StoragePort } from "@agentproto/wallet/ports"
import type { BillingHandle } from "./define-billing-manifest.js"

/**
 * A journal event with the optional AIP-49 amendment fields. `cause` is the
 * identity of the money movement that made the event happen (AIP-74 rules 2
 * and 5); `origin` is the provenance of minted value. A storage adapter that
 * drops them breaks `traceOf`: see README, wallet gaps.
 */
export type CauseEvent = WalletEvent & { cause?: string; origin?: string }

export type PeriodStatus = "active" | "past_due" | "closed"

/** One paid subscription period, keyed by the movement of the payment that paid it. */
export interface PeriodRecord {
  id: string
  accountId: string
  offerId: string
  startAt: number
  endAt: number
  interval: "week" | "month" | "year"
  /** Includes are given monthly inside a yearly period, once per period otherwise (rule 16). */
  graceMs: number
  status: PeriodStatus
  /** Indexes of the include drops already given. */
  given: number[]
  /** Boolean features the period opens. */
  features: string[]
  graceEndsAt?: number
  closedAt?: number
  closedReason?: "refunded" | "disputed" | "grace_expired" | "no_grace" | "renewed"
}

/** A one-time purchase that opens boolean features. */
export interface AccessRecord {
  id: string
  accountId: string
  features: string[]
  revokedAt?: number
}

export interface BillingStateStore {
  /** Insert or replace by `id`. */
  putPeriod(p: PeriodRecord): Promise<void>
  getPeriod(id: string): Promise<PeriodRecord | null>
  listPeriods(filter?: { accountId?: string; offerId?: string }): Promise<PeriodRecord[]>
  /** Which account a payment movement landed on, so a refund or a dispute (which name only the movement) find it. */
  putPayment(movement: string, accountId: string): Promise<void>
  paymentAccount(movement: string): Promise<string | null>
  putAccess(a: AccessRecord): Promise<void>
  getAccess(id: string): Promise<AccessRecord | null>
  listAccess(accountId: string): Promise<AccessRecord[]>
}

export interface BillingDeps {
  manifest: BillingHandle
  storage: StoragePort
  clock: ClockPort
  state: BillingStateStore
}
