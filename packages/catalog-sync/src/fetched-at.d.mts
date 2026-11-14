/**
 * Types for `fetched-at.mjs` - hand-written alongside the plain-JS module so
 * both the TypeScript generators and the bare-`node` sync scripts share it.
 */

export interface FetchedAtEntry {
  hash: string
  fetchedAt: string
}

export type FetchedAtLedger = Record<string, FetchedAtEntry>

export function fetchedAtLedgerAbsPath(ledgerId: string): string

export function fetchedAtLedgerRelPath(ledgerId: string): string

export function readFetchedAtLedger(ledgerId: string): FetchedAtLedger

export function serializeFetchedAtLedger(ledger: FetchedAtLedger): string

export function hashJson(value: unknown): string

export function resolveFetchedAt(
  previous: FetchedAtLedger,
  key: string,
  hash: string,
  today: string
): { ledger: FetchedAtLedger; entry: FetchedAtEntry }
