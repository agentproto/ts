/**
 * Shared small pieces of the AIP-74 implementation: reference and currency
 * normalisation (rule 22), ISO 8601 durations, fiat asset declarations, and the
 * minor-unit conversion of rule 9.
 */
import type { AssetDeclaration } from "@agentproto/wallet"

/** `aip://49/EUR` and `EUR` are the same asset (rule 22). */
export const normalizeRef = (ref: string): string => ref.replace(/^aip:\/\/49\//, "")

/** Currency codes compare case-insensitively and are stored upper case (rule 22). */
export const normalizeCurrency = (c: string): string => c.toUpperCase()

/** A fiat reference is a bare ISO 4217 code (AIP-74 schema `fiatRef`). */
export const isFiatRef = (ref: string): boolean => /^[A-Z]{3}$/.test(normalizeRef(ref))

/** Fiat default partition, implicit in a manifest (AIP-74 assets). */
export const fiatPartition = (currency: string): string => `${normalizeCurrency(currency)}:default`

/** Currencies with no minor unit, or three. Everything else has two. */
const ZERO_DECIMALS = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"])
const THREE_DECIMALS = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"])
export const fiatDecimals = (currency: string): number => {
  const c = normalizeCurrency(currency)
  return ZERO_DECIMALS.has(c) ? 0 : THREE_DECIMALS.has(c) ? 3 : 2
}

/** The AIP-49 declaration of a fiat asset referenced by `{ ref: aip://49/EUR }`. */
export function fiatDeclaration(ref: string): AssetDeclaration {
  const code = normalizeRef(ref)
  return {
    ref: code,
    name: code,
    symbol: code,
    decimals: fiatDecimals(code),
    standard: "iso4217",
    // Fiat only leaves the journal by a rail refund (rule 6); nothing spends it.
    ruleSet: { settleOut: "stripe", spendableOn: [], convertEdges: [], transfer: "none" },
    partitions: [{ id: fiatPartition(code), asset: code, restriction: [] }],
  } as unknown as AssetDeclaration
}

const DURATION_RE = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

/**
 * `at` plus an ISO 8601 duration, in UTC. Years and months are calendar
 * arithmetic with the day clamped to the target month; the rest is exact.
 */
export function addDuration(at: number, iso: string): number {
  const m = DURATION_RE.exec(iso)
  if (!m) throw new Error(`invalid ISO 8601 duration '${iso}'`)
  const [y, mo, w, d, h, mi, s] = m.slice(1).map(v => (v === undefined ? 0 : Number(v)))
  let t = addMonthsUtc(at, (y ?? 0) * 12 + (mo ?? 0))
  t += ((w ?? 0) * 7 + (d ?? 0)) * 86_400_000 + (h ?? 0) * 3_600_000 + (mi ?? 0) * 60_000 + (s ?? 0) * 1000
  return t
}

/** `at` plus calendar months in UTC, the day clamped to the target month's length. */
export function addMonthsUtc(at: number, months: number): number {
  if (months === 0) return at
  const d = new Date(at)
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months
  const year = Math.floor(total / 12)
  const month = total - year * 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return Date.UTC(year, month, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
}

const EPS = 1e-9

/**
 * Rule 9: `out = floor(in x ratio x 10^(decimals(to) - decimals(from)))`, in
 * minor units. The epsilon only absorbs binary floating point (100 x 1.18 is
 * 118 to nine decimals), it never rounds a real fraction up.
 */
export function convertMinor(inMinor: number, ratio: number, fromDecimals: number, toDecimals: number): number {
  return Math.floor(inMinor * ratio * 10 ** (toDecimals - fromDecimals) + EPS)
}

/** Round a derived ratio to nine decimals so 100 x 1.18 is exactly 118. */
export const roundRatio = (r: number): number => Math.round(r * 1e9) / 1e9
